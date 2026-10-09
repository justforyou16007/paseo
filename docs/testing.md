# Testing

Use real temporary directories, installed artifacts and the actual helper commands. Test the behavior visible to the worker or project owner. Avoid assertions that mirror implementation details.

Run only the relevant file locally: `npm run test -- tests/test_setup.ts`. Never run the full suite locally or repeat a test another agent has already reported green without a new change or unresolved concern. CI runs the existing four TypeScript suites.

The setup suite builds an archive and exercises Claude and Codex installation, configuration, repair, updates and integrity checks from isolated directories. Run `npm run build` first because the archive consumes compiled helpers.

Do not add provider authentication checks to tests. Report the difference between archive/helper verification and a real two-daemon deployment. Never restart the main Paseo daemon to recover from a test timeout.
