import { EnvBackend } from "./env-backend.js";
import { LocalEnv } from "./local-env.js";
import { DockerEnv } from "./docker-env.js";
import { RemoteEnv } from "./remote-env.js";
import { VastEnv } from "./vast-env.js";
import { ModalEnv } from "./modal-env.js";
export { EnvBackend, EnvError, runShell, shellQuote } from "./env-backend.js";

export function createBackend(
  envType: string,
  config: Record<string, unknown>,
  stateDir = ".",
  dryRun = false,
): EnvBackend {
  const registry: Record<
    string,
    new (config: Record<string, unknown>, stateDir: string, dryRun: boolean) => EnvBackend
  > = {
    local: LocalEnv,
    docker: DockerEnv,
    remote: RemoteEnv,
    vast: VastEnv,
    modal: ModalEnv,
  };
  const Backend = registry[envType];
  if (!Backend) throw new Error(`unknown env_type '${envType}'`);
  return new Backend(config, stateDir, dryRun);
}
