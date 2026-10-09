# Auto Research Loop

[中文](README.zh-CN.md)

ARL runs a research task on two separate machines. A worker delivers a zip; a validation service owns a frozen benchmark, starts a review agent and publishes a measured score and sanitized feedback through its `submit` and `query` MCP tools.

This branch contains ARL source, skills, tests and an independent installation archive. Install official Paseo and Claude Code or Codex separately on each machine. Paseo supplies agent execution and monitoring.

## Install

You need Node.js 22.12+, Bash and tar. Download the installer, then choose a provider for each project:

```bash
curl -fsSL https://raw.githubusercontent.com/justforyou16007/paseo/arl/distribution/install-arl.sh -o /tmp/install-arl.sh
bash /tmp/install-arl.sh --provider claude --project /path/to/project
# Or:
bash /tmp/install-arl.sh --provider codex --project /path/to/project
```

The installer verifies the archive checksum and installs project skills, compiled helpers and runtime dependencies. Target machines need no source checkout or npm install. Codex must trust the project to load its project MCP configuration.

Set up the validation project first, then pass its URL and token privately to the worker. Follow the [setup guide](SETUP_GUIDE.md) or [中文部署指南](SETUP_GUIDE_CN.md).

## Develop

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test -- tests/test_setup.ts
npm run pack:arl
```

The archive and checksum are written to `artifacts/`. To refresh the archive downloaded by the Bash installer, copy both files to `distribution/releases/` before committing. See [package ownership and build conventions](docs/arl-install.md), [contributing](CONTRIBUTING.md) and the [architecture guide](ARIS_ARCHITECTURE_GUIDE.md).

`src/` contains the Node helpers; `skills/` contains the core skills and optional integrations. The archive includes five core skills and their runtime dependency closure. The [agent guide](AGENT_GUIDE.md) lists the available skills.

## License

[MIT](LICENSE). Original ARIS copyright and attribution are retained.
