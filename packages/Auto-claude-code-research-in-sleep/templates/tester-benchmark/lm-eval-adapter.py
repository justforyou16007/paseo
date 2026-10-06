#!/usr/bin/env python3
"""Single-task lm-eval facility. Uses pinned local data and retains native evidence."""
import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
from pathlib import Path


def run(argv, **kwargs):
    timeout = kwargs.pop("timeout", None)
    if kwargs.pop("capture_output", False):
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
    with subprocess.Popen(argv, start_new_session=True, **kwargs) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise
        result = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
        result.check_returncode()
        return result


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def convert(native, samples, metric_map, artifact_digest):
    values = {}
    observations = []
    for name, keys in metric_map.items():
        values[name] = float(native[keys["aggregate"]])
    for sample in samples:
        # Native lm-eval doc ids are stable within the pinned task/split.
        scores = {name: float(sample[keys["sample"]]) for name, keys in metric_map.items()}
        observations.append({"id": str(sample["doc_id"]), "status": "ok", "metrics": scores})
    return {"artifact_sha256": artifact_digest, "metrics": values, "samples": observations}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["setup", "check", "run"])
    parser.add_argument("--profile", default="lm-eval-profile.json")
    args = parser.parse_args()
    profile_path = Path(args.profile).resolve()
    cfg = json.loads(profile_path.read_text())
    cwd = profile_path.parent
    os.chdir(cwd)
    harness = cwd / "harness"
    python = str(cwd / ".venv/bin/python")
    evaluator = str(cwd / ".venv/bin/lm-eval")
    if args.action == "setup":
        for key, pattern in [("harness_revision", r"[0-9a-f]{40}"), ("dataset_revision", r"[0-9a-f]{40}")]:
            if not re.fullmatch(pattern, cfg[key]):
                raise ValueError(f"{key} must be an exact commit SHA")
        if not harness.exists():
            run(["git", "clone", "https://github.com/EleutherAI/lm-evaluation-harness.git", str(harness)])
        run(["git", "-C", str(harness), "fetch", "origin", cfg["harness_revision"]])
        run(["git", "-C", str(harness), "checkout", "--detach", cfg["harness_revision"]])
        if not Path(python).exists():
            run(["python3", "-m", "venv", str(cwd / ".venv")])
        run([python, "-m", "pip", "install", str(harness) + "[hf]"])
        run([python, "-c", "import json,sys; from datasets import load_dataset; c=json.load(open(sys.argv[1])); d=load_dataset(c['dataset_name'],revision=c['dataset_revision'],split=c['dataset_split']); assert len(d)==c['expected_samples'], 'dataset count changed'; d.to_json('data.jsonl')", str(profile_path)])
        # Inherit the benchmark's original prompt/scorer, replace only the data source.
        task = {"include": cfg["base_task"], "task": cfg["task"], "dataset_path": "json", "dataset_name": None, "dataset_kwargs": {"data_files": {"test": str(cwd / "data.jsonl")}}, "test_split": "test", "validation_split": None, "training_split": None, "fewshot_split": "test"}
        (cwd / "tasks").mkdir(exist_ok=True)
        # JSON is valid YAML and avoids an extra YAML dependency in the adapter.
        (cwd / "tasks/task.yaml").write_text(json.dumps(task, indent=2) + "\n")
        manifest = {"dataset_revision": cfg["dataset_revision"], "split": cfg["dataset_split"], "samples": cfg["expected_samples"], "data_sha256": sha(cwd / "data.jsonl")}
        (cwd / "data-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        frozen = run([python, "-m", "pip", "freeze", "--all"], capture_output=True, text=True).stdout
        (cwd / "requirements-installed.txt").write_text(frozen)
        return
    revision = run(["git", "-C", str(harness), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if revision != cfg["harness_revision"]:
        raise ValueError("installed harness revision differs from setup")
    run(["git", "-C", str(harness), "diff", "--exit-code", "HEAD"])
    if sha(cwd / "data.jsonl") != json.loads((cwd / "data-manifest.json").read_text())["data_sha256"]:
        raise ValueError("installed data changed")
    frozen = run([python, "-m", "pip", "freeze", "--all"], capture_output=True, text=True).stdout
    if frozen != (cwd / "requirements-installed.txt").read_text():
        raise ValueError("installed dependencies changed")
    if args.action == "check":
        run([evaluator, "validate", "--tasks", cfg["task"], "--include_path", str(cwd / "tasks")])
        return
    mode = os.environ.get("ARIS_TEST_MODE", "smoke")
    target = Path(os.environ.get("ARIS_TEST_DIR", str(cwd / "setup-smoke")))
    # Each attempt gets a fresh native output directory; old final outputs cannot win a glob.
    import tempfile
    target.mkdir(parents=True, exist_ok=True)
    native_dir = Path(tempfile.mkdtemp(prefix="native-", dir=target))
    model_args = cfg["smoke_model_args"] if mode == "smoke" else cfg["model_args"].replace("{artifact_ref}", os.environ["ARIS_ARTIFACT_REF"])
    argv = [evaluator, "run", "--model", cfg["model"], "--model_args", model_args, "--tasks", cfg["task"], "--include_path", str(cwd / "tasks"), "--output_path", str(native_dir), "--log_samples", "--seed", str(cfg["seed"]), "--num_fewshot", str(cfg["num_fewshot"]), "--device", cfg["device"], "--batch_size", str(cfg["batch_size"])]
    if mode == "smoke":
        argv += ["--limit", str(cfg["smoke_samples"])]
    # Enforce this timeout on the remote machine as well as in the ARIS controller.
    run(argv, timeout=cfg["timeout_seconds"])
    results = list(native_dir.rglob("results*.json"))
    logs = list(native_dir.rglob("samples_*.jsonl"))
    if len(results) != 1 or len(logs) != 1:
        raise ValueError("expected exactly one task result and sample log")
    aggregate = json.loads(results[0].read_text())["results"][cfg["task"]]
    samples = [json.loads(line) for line in logs[0].read_text().splitlines() if line.strip()]
    raw = convert(aggregate, samples, cfg["metric_map"], os.environ.get("ARIS_ARTIFACT_SHA256", "setup-smoke"))
    expected = cfg["expected_samples"] if mode == "full" else cfg["smoke_samples"]
    if len(samples) != expected:
        raise ValueError("benchmark coverage differs from declared protocol")
    raw["evidence_files"] = [str(results[0]), str(logs[0]), str(profile_path), str(cwd / "tasks/task.yaml"), str(cwd / "data-manifest.json")]
    Path(os.environ.get("ARIS_TEST_OUTPUT", str(target / "benchmark-output.json"))).write_text(json.dumps(raw, indent=2) + "\n")


if __name__ == "__main__":
    main()
