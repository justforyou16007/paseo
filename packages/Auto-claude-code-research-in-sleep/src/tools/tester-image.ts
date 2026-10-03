import { runTesterCommand, TESTER_MANUAL_PATH, type TesterAgentTransport } from "./tester-agent.js";
import { failA1, requireInteger, requireString } from "./workflow-spec.js";

/**
 * Every tester container is made from one base image on the docker host: the
 * Paseo image with the claude CLI and a docker client added, starting as the
 * `paseo` account. `/aris-update` pulls the published build and gives it the
 * local name; ARIS never builds it. A missing image stops setup instead.
 */

/** Published by `.github/workflows/aris-tester-image.yml`. */
export const PUBLISHED_TESTER_IMAGE = "ghcr.io/justforyou16007/aris-tester-base:latest";
/** The local name `create-container` uses unless told otherwise. */
export const DEFAULT_TESTER_IMAGE = "aris-tester-base:latest";

const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DOCKER_SOCKET = "/var/run/docker.sock";
/** The account the Paseo image runs its daemon and agents as. */
export const TESTER_CONTAINER_USER = "paseo";

function checked(value: unknown, pattern: RegExp, location: string): string {
  const result = requireString(value, location);
  if (result.length > 255 || !pattern.test(result))
    failA1("INVALID_VALUE", "not a usable docker name", location);
  return result;
}

/**
 * Failures name the failed step and the command, because nothing about them
 * is private: the operator re-runs the command by hand to see docker's own
 * output.
 */
async function mustRun(
  transport: TesterAgentTransport,
  argv: string[],
  step: string,
  timeoutMs: number,
  code = "TESTER_CONTAINER_FAILED",
): Promise<string> {
  const result = await transport({ kind: "control", argv, timeout_ms: timeoutMs });
  if (result.code !== 0) failA1(code, `${step} failed: ${argv.join(" ")}`, step);
  return result.stdout;
}

export interface CreateTesterContainerInput {
  image: string;
  container: string;
  /** Named volume mounted as the account's home: claude login and daemon state. */
  home_volume: string;
  timeout_ms: number;
  transport?: TesterAgentTransport;
}

export interface CreateTesterContainerResult {
  container: string;
  container_user: string;
  image: string;
  home_volume: string;
  /** False when a container of that name from the same image already existed. */
  created: boolean;
}

/**
 * The group that owns the docker socket, read from inside a throwaway
 * container because that is where the tester sees it: on Docker Desktop the
 * socket's group inside a container differs from the host's. `stat` only reads
 * the inode, so the image's own account can run it.
 */
async function socketGroup(
  transport: TesterAgentTransport,
  image: string,
  timeoutMs: number,
): Promise<string> {
  const gid = (
    await mustRun(
      transport,
      [
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "stat",
        "--volume",
        `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
        image,
        "-c",
        "%g",
        DOCKER_SOCKET,
      ],
      "socket-group",
      timeoutMs,
    )
  ).trim();
  if (!/^\d+$/.test(gid))
    failA1("TESTER_CONTAINER_FAILED", "socket-group printed no numeric group id", "socket-group");
  return gid;
}

/**
 * Create the tester container from the base image, or start the
 * existing one.
 * A container under that name made from another image is refused rather than
 * reused: it is somebody else's container.
 */
export async function createTesterContainer(
  input: CreateTesterContainerInput,
): Promise<CreateTesterContainerResult> {
  const image = checked(input.image, IMAGE_REFERENCE, "image");
  const container = checked(input.container, DOCKER_NAME, "container");
  const volume = checked(input.home_volume, DOCKER_NAME, "home_volume");
  const timeout = requireInteger(input.timeout_ms, "timeout_ms", 1000);
  const transport = input.transport ?? runTesterCommand;
  const result = (created: boolean): CreateTesterContainerResult => ({
    container,
    container_user: TESTER_CONTAINER_USER,
    image,
    home_volume: volume,
    created,
  });

  const existing = await transport({
    kind: "fetch",
    argv: ["docker", "container", "inspect", "--format", "{{.Config.Image}}", container],
    timeout_ms: timeout,
  });
  if (existing.code === 0) {
    if (existing.stdout.trim() !== image)
      failA1(
        "TESTER_CONTAINER_TAKEN",
        `container ${container} exists and was not made from ${image}`,
        "container",
      );
    // A no-op for a running container; its user and socket group were fixed
    // when it was created.
    await mustRun(transport, ["docker", "start", container], "start", timeout);
    return result(false);
  }

  const present = await transport({
    kind: "fetch",
    argv: ["docker", "image", "inspect", "--format", "{{.Id}}", image],
    timeout_ms: timeout,
  });
  if (present.code !== 0)
    failA1(
      "TESTER_IMAGE_MISSING",
      `${image} is not on this docker host; run /aris-update to pull the tester base image`,
      "image",
    );

  // Nothing runs as root. The image starts as the daemon's account, so the
  // Paseo entrypoint never switches user, and the socket group added here
  // stays on the daemon and every agent it starts.
  const gid = await socketGroup(transport, image, timeout);
  await mustRun(
    transport,
    [
      "docker",
      "run",
      "--detach",
      "--name",
      container,
      "--restart",
      "unless-stopped",
      "--user",
      TESTER_CONTAINER_USER,
      "--group-add",
      gid,
      "--volume",
      `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
      "--volume",
      `${volume}:/home/${TESTER_CONTAINER_USER}`,
      image,
    ],
    "run",
    timeout,
  );
  return result(true);
}

export interface PullTesterImageInput {
  /** The published reference to pull. */
  source: string;
  /** The local name to give it. */
  image: string;
  /** SHA-256 of `templates/tester-agent-bundle/TESTER_AGENT.md` in this version. */
  manual_sha256: string;
  timeout_ms: number;
  transport?: TesterAgentTransport;
}

export interface PullTesterImageResult {
  image: string;
  source: string;
  /** `sha256:<hex>` image id now under the local name. */
  id: string;
  /** False when the local name already pointed at this image. */
  changed: boolean;
}

async function imageId(
  transport: TesterAgentTransport,
  image: string,
  timeoutMs: number,
): Promise<string | null> {
  const result = await transport({
    kind: "fetch",
    argv: ["docker", "image", "inspect", "--format", "{{.Id}}", image],
    timeout_ms: timeoutMs,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Pull the published base image and give it the local name. The local name
 * moves only after the pulled image's manual proves to be this version's,
 * because deploy refuses any other; a mismatch leaves the local image as it
 * was.
 */
export async function pullTesterImage(input: PullTesterImageInput): Promise<PullTesterImageResult> {
  const source = checked(input.source, IMAGE_REFERENCE, "source");
  const image = checked(input.image, IMAGE_REFERENCE, "image");
  const expected = requireString(input.manual_sha256, "manual_sha256");
  const timeout = requireInteger(input.timeout_ms, "timeout_ms", 1000);
  const transport = input.transport ?? runTesterCommand;

  const before = await imageId(transport, image, timeout);
  await mustRun(transport, ["docker", "pull", source], "pull", timeout, "TESTER_IMAGE_PULL_FAILED");
  // Runs as the image's own account with no network; the entrypoint is
  // replaced, so no daemon starts.
  const output = await mustRun(
    transport,
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "sha256sum",
      source,
      "--",
      TESTER_MANUAL_PATH,
    ],
    "manual-check",
    timeout,
    "TESTER_IMAGE_PULL_FAILED",
  );
  const actual = output.trim().split(/\s+/)[0] ?? "";
  if (actual !== expected)
    failA1(
      "TESTER_MANUAL_MISMATCH",
      `${source} carries manual ${actual || "(none)"}, this ARIS version expects ${expected}: ` +
        "either the image was not rebuilt from this version yet (push the manual change and wait " +
        "for the image workflow), or this ARIS checkout is older than the image (update it, or " +
        "pass --source with the published sha- tag that matches it)",
      "manual",
    );
  const id = await imageId(transport, source, timeout);
  if (id === null)
    failA1("TESTER_IMAGE_PULL_FAILED", `inspect failed: docker image inspect ${source}`, "inspect");
  await mustRun(
    transport,
    ["docker", "tag", source, image],
    "tag",
    timeout,
    "TESTER_IMAGE_PULL_FAILED",
  );
  return { image, source, id, changed: before !== id };
}
