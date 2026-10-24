# Todo148: Z.AI Provider reuses the system ZCode icon

Status: asset corrected from the Dock screenshot; development and this round's verification done (2026-09-15).

## Rule and boundaries

- The user specified the Dock black-background white-Z app icon, not the gray outlined old `logo-zai.svg`.
- `packages/desktop/build/icons/128x128.png` is copied as is to the UI static asset `model-provider-zai-app.png` (this size has no extra margin of the large Dock icon; no redraw, crop or invert). The UI does not reference Desktop paths across layers; a unit test checks the bundled copy is byte-identical to the app source.
- The `zai` asset mapping in `ProviderLogo` covers every existing call site (Provider list, detail title, add templates); no per-Provider-ID checks and no change to Built-in JSON, Schema, personal config or model behavior.
- BigModel's blue icon and other brands are unchanged; light/dark, desktop and Web share one static bundled asset; sizes and load-failure fallback are kept.
- The source manifest points to the PNG actually used and the app source path; the old SVG and other entries stay (no wider asset cleanup).

## Acceptance (done)

- [x] Unit tests: Z.AI light and dark both reference the same app PNG with identical bytes; BigModel still references its original asset.
- [x] Image accessibility attributes, existing sizes and load-failure fallback kept; icon asset check passes.
- [x] Browser: templates, navigation and detail actually load the PNG (decoded 128x128, no invert, no page exception, no extra save); 390 zh-CN light / 1200 English dark screenshots reviewed. Red first (4 failures), then `providerLogo` / `providerLogoAssets` 9 pass; Pro isolated copy `zai app icon` browser cases 2 pass. Root `pnpm typecheck`, Desktop `typecheck:e2e`, lint (0 errors / 42 existing warnings) and architecture (0 violations) pass.

Only the static asset reference changed; no interaction change. The browser cases remain pending; full
Electron / phone shared-host E2E was not run. Codegraph was unavailable (no impact scan). An earlier
(2026-09-14) round chose the wrong SVG asset; that history is superseded and not an acceptance of this PNG.
