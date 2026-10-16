# Todo141: Align the Model Editor Dialog Layout and Advanced-Configuration Experience with Product UX

Status: Complete (implemented and reviewed after renewed user authorization on 2026-09-12). Reconnected the approved decisions in the existing editor; did not merge product-branch code directly.

## Source and Boundaries

- Compared `origin/feat/model-config-ux` (`20648a44f9`, product implementation `7d581b31e6`) with local `ff9a8463e0`.
- Reconnected approved visual and interaction changes in the current editor without replacing whole files. The product branch was based on the old editor and still included inner cards, output type, MFJS, and different checkbox colors/accessibility semantics; these were not adopted.
- This Todo supersedes Todo134's field positions, smart-toggle position, and footer-button layout after implementation. Todo134's draft, overlay, manual validation, and async protections remain effective.
- Change only the add/edit model dialog. Do not expand to Provider pages, model-selection menus, underlying config types, model requests, account synchronization, or data migration.

## Final Layout

| Area                                    | Content and order                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate row below the title            | Smart-configuration name, question mark, and toggle aligned horizontally to the left, with compact internal spacing from the product branch |
| Default body                            | Model ID, context window, maximum output Tokens                                                                                             |
| Advanced settings, collapsed by default | Input types, model capabilities, reasoning-configuration group                                                                              |
| Reasoning-configuration group           | **Reasoning levels and reasoning-parameter mapping adjacent vertically in the same group**; do not separate them or add a card border       |
| Bottom left                             | Reset form: smaller, underlined text button                                                                                                 |
| Bottom right                            | Cancel and Save; Save is primary                                                                                                            |

- Use “Reasoning levels” consistently and retain “from low to high.” This edits the ordered levels supported by the model, not the current session level. The English wording remains Reasoning levels.
- Label the advanced entry “Advanced settings.”
- Keep the current layout without inner cards; do not restore group borders, backgrounds, or extra padding.
- Reduce field-to-field spacing from about 24px to 16px; use about 4px between label and input; keep current spacing between options in the same field. The 16px value was explicitly requested in this round and does not imply that the product implementation is complete.
- Keep the outer dialog, fixed title, and footer; only the body scrolls. Allow reasonable wrapping on narrow screens without squeezing out actions or causing horizontal overflow.

## Controls and Expansion Interaction

- Show checkbox indicators for every input type, including text. Text stays checked and cannot be unchecked; retain the lock explanation. Keep current editing behavior for images, video, and PDF.
- Continue using the existing checkboxes for model capabilities. Reuse their current indicator style; do not adopt product-branch colors or outer accessibility semantics, and do not nest a second interactive checkbox.
- Give the Advanced entry a background only on hover; return it to transparent on pointer exit while keeping visible keyboard focus. The chevron direction reflects expanded/collapsed state.
- Add expand/collapse and fade-in/fade-out animation, preferring existing component capabilities. Animation must not hide content, overlay borders, or leave the wrong focus invisible.
- Expand/collapse changes presentation only. Preserve the draft and local editing state for reasoning levels; do not save, reinitialize, or issue extra configuration queries. Existing behavior on normal blur remains unchanged.
- Reopen the dialog with Advanced settings collapsed by default.

## Preserved Behavior and Required Wiring

1. Add and Edit share one view. Preserve the existing read-only-ID rule, initial focus, IME handling, technical input attributes, and drag exclusions.
2. “Reset form” changes only the label and style, and continues calling the existing draft-reset logic: restore the complete editable draft, retain model ID and independent `enabled`, and do not save immediately. It does not restore the values from when the dialog was first opened.
3. Basic and advanced fields belong to the same draft and the same save. Collapsing Advanced does not skip validation. Output type and MFJS must not return to the page, draft, or invisible required-field validation; keep the existing manual-editable-schema boundary.
4. Update structured-error focus for the new positions: reasoning-level and reasoning-parameter-mapping errors automatically expand and focus the relevant control; a maximum-output error targets the basic field and does not expand Advanced. Repeated submission of the same error must still focus correctly after manual collapse.
5. The product's default collapse component is not wired into local automatic error expansion and cannot be swapped in directly. Coordinate expansion animation and focus timing; do not use arbitrary timeout fallbacks.
6. Keep editing locked while saving; the smart toggle moved to the title area must also be disabled. Preserve save feedback and cancel behavior.
7. Preserve personal-overlay border, inherited placeholder, help copy, reasoning-level editing/sorting, Map editing format, reset behavior, and stale-request protection.

## Implementation and Acceptance

- [x] Update the relevant layout/interaction tests first and implement through the current abstractions; do not overwrite local boundaries with old product-branch test expectations.
- [x] In both Add and Edit: default three fields, advanced groups, Chinese “reasoning level”/English copy, title-area smart toggle, footer order, and reset style match the table.
- [x] Reasoning levels and mapping are adjacent; text input is checked and locked; other options remain editable; overlay highlighting remains. No inner cards, output type, or MFJS.
- [x] Expand/collapse animation preserves field values and local editing state without writing configuration; cancel does not save; reopening defaults to collapsed.
- [x] Hidden reasoning-level/Map errors expand and focus; repeated errors still work; maximum-output errors target the basic field.
- [x] Reset changes only the draft; basic/advanced fields save together; manual-mode validation boundary, save-time disabling, and stale async-result protection remain intact.
- [x] Combined verification covers desktop-wide/mobile-narrow layouts, light/dark themes, Chinese/English, keyboard interaction, and body scrolling; update related unit tests and interaction E2E, and explicitly record unrun platforms.
- [x] Review item by item and run relevant typecheck, lint, and architecture checks. Record actual evidence before marking complete; a read-only review alone is not implementation acceptance.

## Implementation, Verification, and Review Record

- Layout changes were limited to the shared model-edit dialog, field presentation, and copy. `useProviderModelDraft`, submission validation, Overlay serialization, request configuration, and synchronization were not changed. Add/Edit continue to share existing data boundaries.
- The advanced section uses mounted CSS grid height/opacity transitions. On collapse, `inert` and `aria-hidden` exclude it from interaction and screen-reader navigation; local level-editing state is retained. Expand based on structured error fields and coordinate focus with the actual animation `finished` event. Repeated validation and closing the dialog clear stale focus; no delayed retry was added.
- Browser verification went from red to green. The complete `provider-settings-batch.test.mjs` passed **26/26**; four Todo141 cases covered Add/Edit, 390px Chinese light / 1200px English dark, normal/reduced motion, repeated validation, local drafts, basic-field errors, joint save, reopen, and cancel. Existing reset-race, save-lock, manual-config, and help interactions passed in the same batch.
- `providerModelMetadataDialog.test.ts`, `providerModelSmartDraft.test.ts`, `providerModelMaxOutputLookup.test.ts`, and `modelConfigHelpCopy.test.ts` passed **51/51**. Root `pnpm typecheck` passed (including Desktop E2E typecheck); `pnpm lint` reported 0 errors / 42 existing warnings; `pnpm architecture:check --changed` reported 0 violations; format checks and `git diff --check` passed.
- A push-gate expansion to 328 test files found four outdated expectations in two old tests: advanced fields must first be expanded, maximum output is no longer in Advanced, and “reasoning tiers” is now “reasoning levels.” Updated those focus/copy expectations, retained substantive assertions that late queries do not overwrite user input and editing/expansion do not trigger extra queries, and added a reset-copy check. All four files passed again together.
- Reviewed real browser screenshots: measured 16px field spacing, no horizontal overflow on narrow screens, and scrollable body after expansion while the title/footer remain fixed. Screenshots and Playwright trace are in `/tmp/zcode-provider-settings-batch/todo141-*`.
- Item-by-item review confirmed reasoning levels and mapping share a borderless group, maximum output is in the basic area, text uses the existing checkbox indicator and lock icon without changing option accessibility semantics or overlay colors, reset changes only the draft and retains ID/`enabled`, and hidden system fields are not added to manual required-field rules.
- Boundary: verification ran in Linux Chromium against real shared UI with isolated service fixtures; it does not represent Mac Electron or mobile shared-host device testing. The native `provider-model-smart-config.test.ts` updated selectors/copy and passed typecheck, but the native test was not rerun in this round; pending cases were not promoted without authorization. Codegraph was unavailable; review was targeted through the shared dialog, both entry points, draft Hook, validation, and controls.
