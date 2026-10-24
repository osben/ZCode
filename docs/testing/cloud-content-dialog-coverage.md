# Cloud content dialog acceptance record

Date: 2026-09-04. Case semantics come from the accepted cases in section 7 of `docs/cloud-content-dialog-plan.md`.

## Current appearance and rendering rules

- Close button: the Hero background cannot be inferred from the app theme, so the cloud content dialog uses a circular media-overlay button: black background at 50% opacity, white icon, no border, black 65% on hover. The style is scoped to the cloud content dialog; size, position, focus, close logic and reporting are unchanged. Unit tests constrain the style scope; the App E2E checks icon/no-border in light and dark themes, the actual background, and hover/mouse-out restore.
- No outer border: the dialog shows no outer border and keeps its rounded corners and shadow. The Hero slot clips all media (including the iframe) to the dialog's top rounded corners with an explicit `clip-path` that uses the same radius token (computed value `inset(0px round 16px 16px 0px 0px)`); it does not rely on child resources for rounding. Vertical dialog scrolling and close interaction are kept. The global Dialog, ZIP and message protocol are untouched.
- Square dark corner block: reproducible only with an actual-window screenshot (`Page.captureScreenshot({fromSurface:false})`); the default surface screenshot misses it. Hiding the iframe removes the block; parent `clip-path`/mask and iframe corner radius have no effect; turning off the `DialogOverlay` `backdrop-filter` removes it. Interactive iframe dialogs therefore keep only the semi-transparent overlay with no background blur; other media and ordinary dialogs keep the original blur. Regression checks must include an actual-window screenshot and the computed `clip-path`; DOM hit-testing, `overflow` checks and default screenshots do not suffice. A CDP screenshot does not prove the user's original compositing residue is gone, so user confirmation on site is still needed.

## Coverage map

| Case      | Evidence                                                              | Scope                                                                                                                              |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CCD-01/02 | App pending preview + contentBundleCache/cloudContentService tests    | HTTP JSON, real ZIP, hash/size, unpacked URL, ready, cache hit and re-download after cache clear                                   |
| CCD-03    | cache/service/preview unit + App wrong-hash path                      | Rejects bad resources, no iframe, keeps title/description/close; a valid scene can be retried                                       |
| CCD-04    | media unit + App preview                                              | Real image, WebM decode, Lottie canvas, iframe Replay; both themes; video pauses on reduced-motion/close; Lottie destroyed (unit)   |
| CCD-05    | description unit + App preview                                        | Tag allowlist, dangerous URLs, nesting limit, zh/en, no horizontal overflow at 390px viewport; not equivalent to real-device Web   |
| CCD-06    | dialog unit + App preview                                             | Field/button order, disabled when capability missing, single-flight, failure retry, local copy feedback, mock action recording     |
| CCD-07    | Hero unit + App iframe origin check                                   | contentWindow/instanceId/channel, unknown events rejected; no same-origin, parent DOM unreadable                                    |
| CCD-08    | cache/service integration                                             | Concurrent acquire in one service, multiple leases, cache clear protects active packages, host cancels download; different hosts use independent roots, no multi-process shared cache is claimed |
| CCD-09    | existing start-plan-manual-claim-experience E2E + banner unit         | Success/pending/failure, continuous polling, copy share, model-settings/connection navigation; failure state builds no Hero         |
| CCD-10    | shared types, component degradation, Web build, 390px viewport        | Desktop resources belong to the local host and are not written to the workspace; Web/mobile have no Desktop loopback entry; real phone and remote-workspace runs not done |
| CCD-11    | explicit spec limit                                                   | Markdown is raw-text compatible only; formal dismissal/rate limiting belongs to later delivery and is not counted as covered        |

## Run evidence (macOS Electron only)

- Component unit tests, targeted macOS App MTC-01/07/08 and the isolated Marketing Touch App E2E (12-13 cases) pass for the close button, no-border, top clipping and backdrop-filter changes. The full App preview passes 4/4 (narrow screen, reduced-motion, focus returns to the load button after closing content, to the entry after closing the panel); the Weekend final regression passes 4/4.
- Web build, root typecheck and E2E typecheck pass; architecture check passes; lint has 0 errors (46 pre-existing warnings at last run). Final focused tests: 10 files, 80/80 (including two focus regressions); Node HTTP mock 2/2.
- Full pass of the whole Marketing Touch suite is not claimed: an accidental full run had other failing cases unrelated to this change.
- Full artifacts: `packages/desktop/.e2e-artifacts/desktop-e2e-20260904040413280-p12214-57effa9488fe0d38/summary.md` (preview) and `packages/desktop/.e2e-artifacts/desktop-e2e-20260904040659110-p17722-92d58f3c5b964911/summary.md` (Weekend).

## Problems found during runs and the constraints they left

1. The new ZIP dependency was inlined into the ESM main/host bundle and Electron failed at entry with `Dynamic require of "fs" is not supported`. `yauzl` is now external, listed as a Desktop runtime dependency, and covered by the artifact dependency check and a tsup regression test.
2. Two Weekend regressions saw an extra "model settings -> back to workspace" click while waiting on polling; logs show the result closed via close, not via owner unmount. A run without that extra operation passed 4/4; input-event diagnostics are kept and the polling state machine was not changed.
3. The `safeParse` refine for `https://` could throw; it now checks `URL.canParse` first, with an invalid-URL test.
4. The narrow-screen test once sampled 421px during width transition (target 390px); a layout-settle wait was added and the boundary assertion is unchanged; production CSS is not relaxed.
5. The controlled dialog has no Radix Trigger, so focus fell to body after close. The open source is now recorded and restored; the preview panel uses `DialogTrigger`; because the async-loading button is temporarily disabled and loses `activeElement`, the preview passes an explicit host-side `returnFocusRef` (not a cloud field).
6. One Weekend rerun timed out expanding the Subagents model submenu after the claim dialog closed and settings navigation/benefit refresh finished. Only failure diagnostics were added; model business and assertions are unchanged. The same production code passed 4/4 on rerun. This jitter has no proven root cause and stays an E2E stability risk, not claimed fixed.

## Limits and manual acceptance

- The new preview cases stay in `ui-shell/manual-review/pending`; they are not promoted automatically.
- Verified on macOS Electron only. Windows/Linux/real phone are not tested; cross-platform path constraints are covered by service unit tests and are not presented as platform run results. Full dual-theme visual acceptance was not redone after the border/top-clip change.
- Web/mobile cloud ZIP hosting and production CDN trust/signing/delivery are not wired. The Desktop cache only guarantees reuse within one host lifetime.
- Mock scene actions do not call real business logic; the real claim boundary is verified by the existing Weekend E2E, and no online campaign is requested.
