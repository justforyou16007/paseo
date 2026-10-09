# Standalone Auto Research Loop

ARL installs explicitly into a project and runs with official Paseo. The daemon never installs research skills, and npm postinstall never writes global skill links. Setup, worker/validation separation and the frozen benchmark contract live in the standalone package.

User installation and updates: [ARL setup guide](../packages/Auto-claude-code-research-in-sleep/SETUP_GUIDE.md). That guide is included as the archive's README. Architecture: [ARL architecture](../packages/Auto-claude-code-research-in-sleep/ARIS_ARCHITECTURE_GUIDE.md).

## Build the distributable

From a development checkout with npm dependencies installed:

```bash
npm run pack:arl
```

This builds only the ARL workspace and writes `artifacts/arl-0.1.0.tar.gz` and its `.sha256`. The archive has its own Bash installer, compiled helper dependency closure, Commander runtime, five skills, shared references and templates. No source checkout or npm install is needed on the target machine. Node 22.12+, Bash and tar are host prerequisites; official Paseo and the selected provider supply agent execution.

`tools/pack-arl.mjs` traces local JavaScript imports from the setup, validation, wiki and environment entrypoints. When adding a runtime entrypoint, add it there; do not ship all unrelated research tools. Keep archive dependencies independent of Paseo packages.

The branch also carries a prebuilt archive in `distribution/releases/` for the Bash bootstrap. After changing package code or skills, rebuild and refresh it before committing:

```bash
npm run pack:arl
node packages/Auto-claude-code-research-in-sleep/tools/pack-arl.mjs packages/Auto-claude-code-research-in-sleep/distribution/releases
```

The bootstrap uses that branch URL by default. Set `ARL_ARCHIVE` to a local `.tar.gz` (with its adjacent `.sha256`) for offline testing, or `ARL_DOWNLOAD_BASE` for a mirror. These settings apply only to downloading an archive, never to runtime helper resolution.

## Ownership

The installation manifest records provider and managed file hashes. Updates preflight conflicts and replace only owned package files. Project data, generated experiment skills and unrelated provider configuration survive. The provider stays fixed for a project so setup and generated environment skills agree on discovery paths.

Official Paseo has no ARIS knowledge graph UI. The custom checkout's graph code is separate from this artifact; the wiki remains usable through Markdown and its CLI.
