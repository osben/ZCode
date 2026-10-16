# Todo134: Simplified Model Editor View and Advanced Settings Expansion

Status: Implementation, review, and verification within this round's scope are complete. The user approved all decisions below; formal Electron/real mobile-path acceptance was not run this round.

Later layout discussion is recorded in [Todo141](todo-141-model-editor-product-ux-alignment.md). Todo141 is currently a draft and is not being executed; it does not replace the behavior implemented in this document. After renewed user authorization and implementation, update field locations, smart-toggle placement, and footer-button layout.

## Final Interaction and Scope

| Area | Content |
| --- | --- |
| Default body | Model ID, context length, ordered reasoning-level list (edit the supported levels, not the session's selected level) |
| Advanced settings, collapsed by default | Maximum output Token limit, input types, model capabilities, reasoning-parameter mapping |
| Fixed bottom-left | Smart-configuration toggle and existing explanation |
| Fixed bottom-right | Reset (outline button), Save (primary button), Cancel |

- Expand Advanced settings inline within the same dialog; do not use the separate secondary page considered in early discussion. Do not repeat basic fields.
- Add and Edit reuse the same view. Built-in model IDs remain read-only. Reopening the dialog defaults to collapsed Advanced settings.
- Remove borders, corner radius, and padding from inner group cards. Keep the outer dialog and input-control styles; do not expand changes to Provider forms or model lists.
- Preserve personal-overlay border highlighting, inherited placeholders, help copy, reasoning-level editing, Map format, drag exclusion, IME, and save feedback.
- Latest explicit approval: use checkbox indicators for editable boolean options; retain the original button hit area, keyboard semantics, and overlay highlight. Do not nest a focusable checkbox inside the button. Fixed text inputs retain their lock explanation.
- Make Reset an outlined button to the left of Save. It still restores the entire editable draft, preserves model ID and independent `enabled`, and does not write immediately.
- Make every field and action accessible on desktop and narrow mobile, in light/dark themes and Chinese/English. On narrow screens, the footer may wrap but must not overflow horizontally.

## Field Ownership and Save Rules

1. Remove the entire output-type group and MFJS tool Schema from the editor UI; do not keep them as non-interactive locked rows. Retain underlying config types, rules, and execution capability.
2. Remove those two fields from the UI draft and overlay markers; do not include them in required-form validation. Manual mode neither accepts nor newly persists them.
3. Follow the general mechanism from Todo130: **manual configuration extracts, cleans, and validates only fields in the editable-field schema**. Do not call the full execution schema and add invisible required fields for users. New system fields are excluded from manual config by default.
4. “Advanced collapsed” changes visibility only. Those fields remain editable and part of the complete draft; do not confuse them with removed system fields.
5. Smart mode saves other items without inventing MFJS/output-type overlays or clearing existing valid personal overlays for system fields. On switching to manual mode, save through the manual schema; system leaves continue to come from rule composition.
6. Some old valid manual files contained MFJS. At the existing file-codec normalization boundary, recognize the old editable or old complete shape and extract current manual fields. Do not change `schemaVersion`, add a global data migration, or pretend unknown/corrupt formats succeeded after stripping fields.
7. Preserve identity and edit-generation protection for existing recommendations and reset behavior. Add no recommendation cache, second draft, or persisted collapse state.

| Action | Draft | Persistence |
| --- | --- | --- |
| Expand/collapse | Preserve all fields | No write |
| Edit basic/advanced fields | Update the same draft | No write |
| Reset / switch smart mode | Use existing Hook and async protection | No write |
| Save | Validate all editable fields; automatically expand and focus errors in advanced fields | Use the existing submission only after validation succeeds |
| Cancel | Discard this editing session | No write |

Use existing structured field identifiers to locate errors; do not parse translated copy. Resubmitting the same error after manually collapsing Advanced must also expand it. Keep existing control locking while saving. Do not change ModelSelection, account synchronization, requests, or in-flight execution to fix presentation.

## Impact and Acceptance

- UI: `ProviderFormControls` / `ProviderCardSections` share the Dialog, `useProviderModelDraft`, draft submission, and personal-overlay mechanisms.
- Provider: change only MFJS ownership in the manual-editable schema; continue reusing the schema for extraction/cleanup.
- Provider-node: normalize old manual formats at the existing codec boundary. Do not change the full execution schema.
- Do not change desktop continuous/mobile replayable paths, shared-host, Registry authority, databases, or real user config.
- Codegraph was unavailable; use targeted searches for declared provider-settings/model-capabilities surfaces. Architecture context returned legacy/unmanaged; no new module boundary.

| Case | Requirement |
| --- | --- |
| M134-01 | Basic fields visible by default, Advanced collapsed; no MFJS/output type; correct footer order |
| M134-02 | Expand/collapse preserves values and does not write; overlay highlight, checkboxes, and locked text remain |
| M134-03 | Basic/advanced fields submit together; manual save excludes hidden system fields |
| M134-04 | Advanced-field error expands and focuses; same error works on repeat submission |
| M134-05 | Existing protection for reset/mode/close/save and stale recommendation results remains |
| M134-06 | New model ID editable, built-in edit read-only; cancel does not persist and reopening defaults to collapsed |
| M134-07 | Desktop/narrow screen, light/dark, Chinese/English, labels/keyboard help, and footer layout |
| M134-08 | New manual schema rejects hidden fields; can save without MFJS; system MFJS follows rules |
| M134-09 | Old valid manual shape can be read and survives repeated read/write; unknown/corrupt config remains rejected |
| M134-10 | Unrelated smart-mode edits retain existing hidden system overlays and create no new hidden overlays |

Acceptance uses domain/draft unit tests and actual Chromium interactions with real components/Hooks. Update the existing Electron E2E fields and advanced-expansion steps. A component fixture does not count as full mobile shared-host or production-client acceptance.

## Baseline and Record

- Fetched `origin/staging` at `6121d8ba48` before work. Its new changes did not affect the model editor; no merge was performed this round.
- Implementation started at `95c80f4ed8` on branch `provider-stabilization-20260911`; freshness and architecture-baseline checks passed.
- Todo130's general field-ownership principle remains valid; this Todo updates MFJS's specific ownership. Preserve Todo131's reset semantics; this Todo supersedes its layout.
- The demo approved only hierarchical expansion and checkbox direction; do not use other custom styling as implementation guidance. The earlier “separate secondary page / smart toggle under ID” discussion was superseded by this final decision.

## Implementation and Review Results (2026-09-12)

- Implemented the interactions and field ownership above. The advanced component manages presentation/error focus only; model state remains owned by the existing Hook/submission callback. Both entry points pass structured validation fields.
- Removed the unused output control (no references or re-exports found by repository-wide dep:refs). Editable options use decorative checkboxes while preserving outer button interaction and overlay highlight. No nested interactive controls.
- Unit tests: 51 Provider, Provider-node, and related UI draft/layout files passed 565 cases; two later read-only-ID permission cases passed (22 cases in that file), for 567 total. New tests first confirmed failure against the old implementation.
- Real Chromium components/Hooks passed eight checks for reset-generation protection, Chinese/English help/layout, advanced expand/preserve/save/error focus. After adding basic+advanced joint save, cancel, and highlight/checkbox styles, six related cases passed again. Covered 390px Chinese light and 1200px English dark; this was not a static HTML demo.
- Reviewed runtime screenshots. Chromium was initially missing a dynamic library, so existing temporary dependencies were reused. The first screenshots lacked CJK fonts; screenshots were retaken with fonts extracted in an isolated directory for this round. No system installation or user config was modified.
- `pnpm typecheck` passed; `pnpm lint` reported 0 errors / 42 warnings (no warnings in changed files); architecture check reported 0 violations; changed-file format and diff checks passed.
- Updated the existing Electron pending E2E for the footer switch, Advanced expansion, and MFJS exclusion assertions; did not promote the pending case to a formal regression. Did not launch formal Electron, Pro, or real mobile shared-host testing; do not claim those passed.
- Verification logs: `/tmp/todo134-unit-final.log`, `/tmp/todo134-unit-extra.log`, `/tmp/todo134-browser5.log`, `/tmp/todo134-browser-delivery.log`; screenshots: `/tmp/zcode-provider-settings-batch/todo134-*.png` (local evidence, not committed).
- Scope review: did not change the full execution schema, Built-in request capability, Selection, account state, tables, protocol, or remote-control paths. Current versions can read old valid manual files; compatibility of older clients with the new manual format without MFJS is not promised. Back up matching config before application rollback. No hidden dual-write field was added for this reason.
- A pre-push related-test follow-up found that the service-layer `providerRuntime` fixture still supplied MFJS only through manual rules after 5,357 tests passed. Restored that system field to the test Built-in and added an end-to-end assertion that manual rules omit it while Registry execution config has it. Production Built-in already had default MFJS; no service product code was changed.
