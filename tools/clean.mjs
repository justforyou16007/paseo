import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

for (const name of ["dist", "tsconfig.tsbuildinfo"]) {
  rmSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), { recursive: true, force: true });
}
