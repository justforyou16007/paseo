# Standalone Auto Research Loop

ARL installs explicitly into projects and uses official Paseo as an external agent runtime. This repository contains no Paseo implementation. User installation and updates live in the [setup guide](../SETUP_GUIDE.md); the archive includes that guide as its README.

## Build the distributable

Run `npm ci` in this repository, then `npm run pack:arl`. No workspace packages or generated declarations from another repository are required. Node.js 22.12+, Bash and tar are host prerequisites.

The build writes `artifacts/arl-0.1.0.tar.gz` and its `.sha256`. The archive contains its Bash installer, compiled helper dependency closure, Commander runtime, six core skills, shared references and templates. Target machines need no build tools, source checkout or npm install. Browser and experiment host dependencies remain external; see the [setup guide](../SETUP_GUIDE.md).

`tools/pack-arl.mjs` traces local JavaScript imports from the setup, validation, wiki, browser, environment and queue entrypoints. Add new runtime entrypoints there rather than shipping unrelated tools. Queue deployment transfers the compiled runtime and its package dependencies together; copying the scheduler file alone loses its imports.

The Bash bootstrap downloads the tracked archive from `distribution/releases/` on the `arl` branch. After changing shipped code, skills or documentation, run `npm run pack:arl` and copy the archive and checksum into that directory before committing. Set `ARL_ARCHIVE` to a local `.tar.gz` with its adjacent `.sha256` for offline installation, or `ARL_DOWNLOAD_BASE` for a mirror.

## Ownership

The installation manifest records the provider and managed file hashes. Updates preflight conflicts and replace only owned package files. Project data, generated experiment skills and unrelated provider configuration survive. Keep the provider fixed for a project so setup and generated environment skills use the same discovery paths.

Official Paseo displays agents and service scripts. Read research records through the wiki skill, CLI or Markdown files. See the [architecture guide](../ARIS_ARCHITECTURE_GUIDE.md) for the worker/validation trust boundary.
