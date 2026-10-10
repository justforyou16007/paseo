# Auto Research Loop

This repository contains ARL. Official Paseo is an external runtime; do not add its app, daemon, relay or CLI source here.

Read `docs/` before non-trivial changes. Package conventions are in [docs/arl-install.md](docs/arl-install.md), coding rules in [docs/coding-standards.md](docs/coding-standards.md), testing in [docs/testing.md](docs/testing.md), and system constraints in [ARIS_ARCHITECTURE_GUIDE.md](ARIS_ARCHITECTURE_GUIDE.md).

Cross-project experience lives in [Experience.md](Experience.md) on this repository's local `arl` branch. Read applicable lessons before work; after each completed worker → validation cycle, save only concise, evidenced and reusable lessons under the [experience contract](skills/shared-references/experience.md). Project-specific details belong in the project wiki.

- Preserve the worker/validation separation, frozen benchmark, measured scores and feedback leak checks.
- Keep Claude and Codex project installation independent of global configuration.
- Keep helpers compatible with Node.js 22.12+ and Windows; launch configured commands as argv arrays.
- Run `npm run typecheck` and `npm run lint` after changes, and `npm run format` before committing.
- Run only the relevant test file with `npm run test -- tests/<file>.ts`; leave the full test matrix to CI.
- Refresh `distribution/releases/` from `npm run pack:arl` when shipped code, skills or documentation changes.
- Never restart a running Paseo daemon without permission.
