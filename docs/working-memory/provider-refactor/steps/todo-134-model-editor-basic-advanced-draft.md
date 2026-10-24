# Todo134: Simplified model editor view and advanced settings expansion

Status: implementation, review and verification within this round's scope are complete (2026-09-12). The
user approved all decisions below; formal Electron / real mobile-path acceptance was not run.

Later layout discussion is in [Todo141](todo-141-model-editor-product-ux-alignment.md): a draft that is not
being executed and does not replace the behavior here. After renewed authorization and implementation,
field locations, smart-toggle placement and footer layout are updated there.

## Final interaction and scope

| Area                                    | Content                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Default body                            | Model ID, context length, ordered reasoning-level list (edit the supported levels, not the session's selected level) |
| Advanced settings, collapsed by default | Maximum output token limit, input types, model capabilities, reasoning-parameter mapping                             |
| Fixed bottom-left                       | Smart-configuration toggle and existing explanation                                                                  |
| Fixed bottom-right                      | Reset (outline button), Save (primary button), Cancel                                                                |

- Advanced settings expand inline in the same dialog (no separate secondary page); basic fields are not repeated.
- Add and Edit reuse the same view. Built-in model IDs stay read-only. Reopening defaults to collapsed Advanced settings.
- Inner group cards lose borders, radius and padding; outer dialog and input styles are kept; Provider forms and model lists are not touched.
- Preserved: personal-overlay border highlight, inherited placeholders, help copy, reasoning-level editing, Map format, drag exclusion, IME, save feedback.
- Editable boolean options use checkbox indicators (decorative; the original button hit area, keyboard semantics and overlay highlight are kept; no nested focusable checkbox). Fixed text inputs keep their lock explanation.
- Reset is an outline button left of Save. It still restores the entire editable draft, keeps model ID and independent `enabled`, and does not write immediately.
- Every field and action is reachable on desktop and narrow mobile, light/dark, Chinese/English; on narrow screens the footer may wrap but never overflows horizontally.

## Field ownership and save rules

1. The output-type group and MFJS tool Schema are removed from the editor UI entirely (no locked rows). Underlying config types, rules and execution capability stay.
2. Both fields leave the UI draft and overlay markers and required-form validation. Manual mode neither accepts nor newly persists them.
3. Per Todo130: **manual configuration extracts, cleans and validates only fields in the editable-field schema**; the full execution schema is not called and no invisible required fields are added. New system fields are excluded from manual config by default.
4. "Advanced collapsed" is visibility only; those fields remain editable and part of the complete draft.
5. Smart mode saves other items without inventing MFJS/output-type overlays or clearing existing valid personal overlays for system fields. Switching to manual saves through the manual schema; system leaves keep coming from rule composition.
6. Some old valid manual files contained MFJS. At the existing file-codec normalization boundary, recognize the old editable or old complete shape and extract current manual fields. No `schemaVersion` change, no global data migration; unknown/corrupt formats are not pretended successful.
7. Identity and edit-generation protection of recommendations and reset is preserved. No recommendation cache, second draft or persisted collapse state.

| Action                     | Draft                                                                                  | Persistence                                                |
| -------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Expand/collapse            | all fields preserved                                                                   | no write                                                   |
| Edit basic/advanced fields | update the same draft                                                                  | no write                                                   |
| Reset / switch smart mode  | existing Hook and async protection                                                     | no write                                                   |
| Save                       | validate all editable fields; auto-expand and focus errors in advanced fields          | existing submission only after validation succeeds         |
| Cancel                     | discard this editing session                                                           | no write                                                   |

Errors are located by existing structured field identifiers, not translated copy. Re-submitting the same
error after manually collapsing Advanced also expands it. Existing control locking while saving stays.
ModelSelection, account synchronization, requests and in-flight execution are not changed for presentation.

## Impact and acceptance

- UI: `ProviderFormControls` / `ProviderCardSections` share the Dialog, `useProviderModelDraft`, draft submission and personal-overlay mechanisms.
- Provider: only MFJS ownership changes in the manual-editable schema; extraction/cleanup keep reusing the schema.
- Provider-node: old manual formats normalized at the existing codec boundary; the full execution schema is unchanged.
- Desktop continuous / mobile replayable paths, shared-host, Registry authority, databases and real user config are untouched.

| Case    | Requirement                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| M134-01 | Basic fields visible by default, Advanced collapsed; no MFJS/output type; correct footer order               |
| M134-02 | Expand/collapse preserves values and does not write; overlay highlight, checkboxes, locked text remain       |
| M134-03 | Basic/advanced fields submit together; manual save excludes hidden system fields                             |
| M134-04 | Advanced-field error expands and focuses; same error works on repeat submission                              |
| M134-05 | Existing protection for reset/mode/close/save and stale recommendation results remains                       |
| M134-06 | New model ID editable, built-in edit read-only; cancel does not persist; reopening defaults to collapsed     |
| M134-07 | Desktop/narrow screen, light/dark, Chinese/English, labels/keyboard help, footer layout                      |
| M134-08 | New manual schema rejects hidden fields; can save without MFJS; system MFJS follows rules                    |
| M134-09 | Old valid manual shape can be read and survives repeated read/write; unknown/corrupt config remains rejected |
| M134-10 | Unrelated smart-mode edits retain existing hidden system overlays and create no new hidden overlays         |

## Relations and result

- Todo130's general field-ownership principle stays; this Todo updates MFJS's ownership. Todo131's reset semantics are preserved, its layout is superseded. The earlier "separate secondary page / smart toggle under ID" discussion is superseded. The demo approved only hierarchical expansion and checkbox direction.
- The advanced component manages presentation/error focus only; model state stays owned by the existing Hook/submission callback; both entry points pass structured validation fields. The unused output control was removed (no references per repository-wide `dep:refs`).
- Tests (failing against the old implementation first): 51 Provider, Provider-node and UI draft/layout files passed 565 cases; two later read-only-ID cases passed (567 total). Real Chromium components/Hooks passed eight checks (reset-generation protection, zh/en help and layout, advanced expand/preserve/save/error focus) and six after adding joint save, cancel and highlight/checkbox styles, at 390px Chinese light and 1200px English dark. `pnpm typecheck` passed; `pnpm lint` 0 errors / 42 warnings (none in changed files); architecture 0 violations. Logs/screenshots are local evidence in `/tmp/todo134-*.log` and `/tmp/zcode-provider-settings-batch/todo134-*.png`, not committed.
- The existing Electron pending E2E was updated for footer switch, Advanced expansion and MFJS exclusion, but not promoted to a formal regression; formal Electron, Pro and real mobile shared-host tests were not run and are not claimed.
- Compatibility: current versions read old valid manual files; compatibility of older clients with the new manual format without MFJS is not promised; back up matching config before an application rollback. No hidden dual-write field was added.
- A pre-push follow-up found that the service-layer `providerRuntime` fixture supplied MFJS only through manual rules; that system field was restored to the test Built-in with an end-to-end assertion that manual rules omit it while Registry execution config has it. Production Built-in already had default MFJS; no service product code changed.
- Baseline: `origin/staging` at `6121d8ba48` did not affect the model editor; no merge this round; implementation started at `95c80f4ed8` on `provider-stabilization-20260911`.
