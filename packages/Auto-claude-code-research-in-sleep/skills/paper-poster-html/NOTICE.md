# NOTICE — third-party provenance

`paper-poster-html` keeps the posterly-derived TypeScript modules under
`src/skills/paper-poster-html/posterly/` and compiles them into
`dist/skills/paper-poster-html/`. The compiled helper directory is the runtime
entry point.

## Vendored from posterly (MIT)

- **Upstream**: posterly — https://github.com/Chenruishuo/posterly
- **License**: MIT, © 2026 Ruishuo Chen. Full text: `LICENSES/posterly-MIT.txt`.
- **Source boundary**: `src/skills/paper-poster-html/posterly/` contains the posterly-derived
  measurement, rendering, polish, preflight, canvas, and final-verification modules.

## ARIS-side additions

These helpers are owned by ARIS and run from the same compiled directory:

- `style-check.js` — style hard-gate.
- `asset-check.js` — real-figure provenance and area gate.
- `run-gates.js` — canonical gate orchestration.
- `extract-pdf-figures.js` — PDF contact sheets and explicit-coordinate crops.
- `preprocess-figures.js` — figure preprocessing and manifest synchronization.
- `templates/tokens/*.json`, `templates/COMPONENTS.md`, `templates/README.md`.

## Update rule

When updating the posterly-derived modules, edit the TypeScript source, rebuild ARIS, and
review the generated helper behavior. Keep the vendor boundary and the ARIS-owned gates in
their current owners. Do not add a second implementation that can be selected after a failure.
