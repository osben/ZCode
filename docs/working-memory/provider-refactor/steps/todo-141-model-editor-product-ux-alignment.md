# Todo141: Align the model editor dialog layout and advanced-configuration experience with product UX

Status: complete (implemented and reviewed after renewed user authorization on 2026-09-12). The approved
decisions were reconnected in the existing editor; product-branch code was not merged directly.

## Source and boundaries

- Compared `origin/feat/model-config-ux` (`20648a44f9`, product implementation `7d581b31e6`) with local `ff9a8463e0`. The product branch was based on the old editor (inner cards, output type, MFJS, different checkbox colors/accessibility semantics); those were not adopted.
- This Todo supersedes Todo134's field positions, smart-toggle position and footer-button layout. Todo134's draft, overlay, manual validation and async protections remain effective.
- Only the add/edit model dialog changes: no Provider pages, model-selection menus, underlying config types, model requests, account sync or data migration.

## Final layout

| Area                                    | Content and order                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Separate row below the title            | Smart-configuration name, question mark and toggle, left-aligned horizontally, compact internal spacing from the product branch |
| Default body                            | Model ID, context window, maximum output tokens                                                                              |
| Advanced settings, collapsed by default | Input types, model capabilities, reasoning-configuration group                                                               |
| Reasoning-configuration group           | **Reasoning levels and reasoning-parameter mapping adjacent vertically in one group**; no card border                         |
| Bottom left                             | Reset form: smaller, underlined text button                                                                                  |
| Bottom right                            | Cancel and Save (Save primary)                                                                                               |

- "Reasoning levels" (zh-CN "推理档位", "from low to high" kept) edits the ordered levels the model supports, not the current session level. The advanced entry is labeled "Advanced settings".
- No inner cards (no group borders, backgrounds or extra padding). Field-to-field spacing about 24px -> 16px (explicitly requested), about 4px label-to-input, current spacing between options in a field.
- Outer dialog, fixed title and footer stay; only the body scrolls. Narrow screens wrap reasonably without squeezing actions or horizontal overflow.

## Controls and expansion

- Checkbox indicators for every input type including text; text stays checked and cannot be unchecked (lock explanation kept); images/video/PDF keep current editing. Model capabilities keep the existing checkboxes and indicator style (no product-branch colors or outer accessibility semantics, no nested interactive checkbox).
- The Advanced entry has a background only on hover (transparent on pointer exit, visible keyboard focus); the chevron reflects expanded/collapsed state.
- Expand/collapse and fade animation, preferring existing component capabilities, must not hide content, overlay borders or leave focus invisible. It changes presentation only: draft and local reasoning-level editing state are preserved; no save, reinitialization or extra configuration query. Reopening defaults to collapsed.

## Preserved behavior and wiring

1. Add and Edit share one view; read-only-ID rule, initial focus, IME handling, technical input attributes and drag exclusions kept.
2. "Reset form" changes only the label/style and still calls the existing draft-reset logic: restore the complete editable draft, keep model ID and independent `enabled`, no immediate save, not the values at dialog open.
3. Basic and advanced fields belong to the same draft and save; collapsing Advanced does not skip validation. Output type and MFJS do not return to the page, draft or invisible required-field validation (manual-editable-schema boundary kept).
4. Structured-error focus for new positions: reasoning-level and reasoning-mapping errors auto-expand and focus the control; a maximum-output error targets the basic field without expanding Advanced; repeated submission of the same error still focuses after manual collapse.
5. The product's default collapse component is not wired to local automatic error expansion and cannot be swapped in; coordinate animation and focus timing without arbitrary timeout fallbacks.
6. Editing is locked while saving; the smart toggle in the title area is also disabled. Save feedback and cancel unchanged.
7. Personal-overlay border, inherited placeholder, help copy, reasoning-level editing/sorting, Map format, reset behavior and stale-request protection preserved.

## Implementation, verification and review

- Changes limited to the shared model-edit dialog, field presentation and copy; `useProviderModelDraft`, submission validation, Overlay serialization, request config and sync untouched.
- The advanced section uses mounted CSS grid height/opacity transitions; on collapse `inert` and `aria-hidden` remove it from interaction and screen readers while local level-editing state stays. Structured error fields trigger expansion, and focus waits for the real animation `finished` event; repeated validation and closing the dialog clear stale focus; no delayed retry.
- Browser verification red -> green: full `provider-settings-batch.test.mjs` **26/26**; four Todo141 cases covered Add/Edit, 390px Chinese light / 1200px English dark, normal/reduced motion, repeated validation, local drafts, basic-field errors, joint save, reopen and cancel; existing reset-race, save-lock, manual-config and help interactions passed in the same batch. `providerModelMetadataDialog.test.ts`, `providerModelSmartDraft.test.ts`, `providerModelMaxOutputLookup.test.ts`, `modelConfigHelpCopy.test.ts` **51/51**. Root `pnpm typecheck` (incl. Desktop E2E typecheck) passed; `pnpm lint` 0 errors / 42 existing warnings; `pnpm architecture:check --changed` 0 violations; format and `git diff --check` passed.
- A push-gate expansion to 328 test files found four outdated expectations in two old tests (advanced fields must first be expanded, max output no longer in Advanced, "reasoning tiers" now "reasoning levels"); updated those focus/copy expectations, kept the substantive assertions (late queries do not overwrite user input; editing/expansion trigger no extra queries) and added a reset-copy check.
- Real screenshots: measured 16px field spacing, no horizontal overflow on narrow screens, scrollable body after expansion with title/footer fixed. Screenshots and Playwright trace: `/tmp/zcode-provider-settings-batch/todo141-*`.
- Item-by-item review confirmed: reasoning levels and mapping share a borderless group; max output in the basic area; text uses the existing checkbox indicator and lock icon with option accessibility semantics and overlay colors unchanged; reset changes only the draft and keeps ID/`enabled`; no hidden system fields added to manual required-field rules.
- Boundary: verified in Linux Chromium with real shared UI and isolated service fixtures; not Mac Electron or mobile shared-host device testing. The native `provider-model-smart-config.test.ts` selectors/copy were updated and typechecked but not rerun this round; pending cases were not promoted without authorization. Codegraph was unavailable; review was targeted through the shared dialog, both entry points, draft Hook, validation and controls.
