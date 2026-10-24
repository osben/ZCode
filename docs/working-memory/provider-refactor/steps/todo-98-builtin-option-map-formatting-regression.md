# Todo 98: Restore the Structural Formatting of Built-in Option Maps

> Status: done and reviewed; 2026-09-09. Includes a small fix for keyboard-drag isolation found in a real run and approved by the user. Wrap-up: development entry closed; residual multi-end verification belongs to [Todo102](todo-102-verification-debt-closeout.md) V102-04, pending manual promotion and the settings fixture checker gap to V102-05, not carried here. Style guideline: [Option Map writing style](../design/model/option-map-writing-style.md).

## 1. Problem and goal

Todo66 required complex Maps to keep line breaks and indentation. `9b0f11e996` (Todo95) simplified the logic but compressed some nested Maps into one line; the settings page shows the source string as is, hence the long-line regression in the screenshot. The earlier request-equivalence tests did not cover the display layout of the real Built-in strings.

Goal: keep the current simplified logic, restore structured layout for nested objects (simple ternaries stay on the same line), and check all Built-in Option Maps including dedicated and API fallback ones, not just the one model in the screenshot.

## 2. Scope and refactor boundary

- The main change is layout of the Maps needing tidying in `config/provider/zcode-builtin.json`, with the revision updated per the existing publish contract, plus necessary tests and verification records. The only added product-code change is the approved keyboard-drag isolation below.
- No restoration of redundant branches; no change to the expression AST, request results for legal inputs, field omission/null, mode, budget or ceiling (this is the change constraint, not the style definition).
- No change to level names/values, Selection migration, rule matching, priority, Overlay or the UI editor's format/save behavior; Todo95C is committed independently and not mixed with this layout diff.
- No new Formatter, DSL or runtime format conversion; Personal Maps are not re-laid-out; no compatibility or migration for unreleased old config.

### 2026-09-09 real-run addendum: keyboard-drag isolation

F98-03 reproduced in Pro with real space typing: the dialog's React Portal keyboard events bubbled to the background model row, the KeyboardSensor consumed the space and triggered a sort write, and the later save failed from a revision change. The pointer sensor already had interactive-target isolation; the keyboard did not reuse it. The user approved a small fix this round: keyboard drag start reuses the existing control/dialog isolation rule; inputs and dialogs do not start background sorting while the model row itself still supports keyboard drag. No change to Map format, the save version check or the sort commit rule, and no drag-system refactor. F98-03 keeps real typed spaces and the original-text save assertion; component-level keyboard and Portal negative cases plus a model-row keyboard positive case were added.

## 3. Impact analysis (planning / presentation)

| Entry                          | Shared implementation and display state                              | Source, validation and save boundary                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| add model                      | Model edit draft -> ProviderModelSettingsGroups -> JsonSlotEditor    | Built-in inherited value as placeholder, explicit draft as value; original validation and save kept; viewing never pins the recommended value                 |
| edit model                     | same controls; Personal/pinned config differs from inherited display | Settings Facade/ConfigService still saves the Personal Overlay; cancel writes nothing                                                                         |
| Desktop / Web / phone settings | same UI                                                              | same config version keeps the same line breaks; narrow-screen soft wrap does not replace the source string's indentation; no Web publish or attachment change |

What is shared is string display; the draft and commit semantics of add/edit and inherited/pinned are not unified or changed. Grading: must-inspect Built-in Map source strings; should-inspect `ProviderModelSettingsGroups.tsx`, `ProviderModelMetadataFields.tsx` value/placeholder; invariant-only Personal save and the Model executor; evidence-only Provider Node, Map, UI display and settings E2E tests. `JsonSlotEditor` uses `value={value}` and `placeholder={effectiveValue}` directly with no formatting step. No codegraph (targeted config diff and direct reading); no new business surface/owner; the graph only adds spec/Todo links.

## 4. Decisions and cases

User ruling: expand objects, two-space indentation, simple ternaries on one line; style and change constraint are separate. No open question. Dimensions kept: nested/simple/complex branch x dedicated/fallback source x placeholder/personal input; no combination of accounts, plans or every theme/language/device (they do not change the source text format); desktop and narrow layout each keep display evidence.

| Case   | Setup / action                                                                                 | Must assert                                                                                                                              | Evidence                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| F98-01 | read representative nested, complex-branch and simple real Built-in Maps                       | object-level line breaks, two-space indentation, simple ternary on one line, simple maxOutput Map not expanded mechanically              | config-level regression test (not a hand-written multi-line fixture)                                     |
| F98-02 | compile and diff old/new Maps                                                                  | expression structure unchanged; no config change beyond Map layout and revision; existing request tests pass                             | reuse existing compile/equivalence tests; no persisted full old-config snapshot or large proof framework |
| F98-03 | settings add/edit showing an inherited Map; type a personal layout then cancel / save normally | inherited line breaks kept; personal input not re-laid-out; viewing/cancel produces no override; normal save keeps the original boundary | shared UI test + representative Electron E2E/screenshots covering desktop and narrow layout              |

Catalog/coverage are merged into this table; implementation reuses `providerModelMetadataDialog.test.ts` and the nearest existing settings E2E cases, adding the case/manifest per e2e-case-lifecycle without copying a whole matrix or auto-promoting pending. Tests first; isolated config, no real account/model request, no sleeps; real phone/Web not run must be stated.

## 5. Order and acceptance

Write the real-config layout red test for F98-01 and the needed display assertions for F98-03 first; tidy the affected Maps and update the publish revision, checking only layout changed (no logic simplification or renaming slipped in); run existing Map/Provider config unit tests and related UI/E2E, `pnpm typecheck`, `pnpm lint`, `git diff --check`; review against the style guideline line by line, keep structure-display screenshots, test results and unverified scope, then commit and update status. Completion needs both source-string/display layout evidence and behavior-unchanged evidence; Todo95's request tests passing does not substitute.

## 6. Implementation, verification and review

- F98-01: a layout assertion on the real Built-in was written and seen red first; 51 of 65 Maps were tidied, revision 12 -> 13. Nested objects expand with two-space indentation, simple ternaries stay on one line, the simple output-limit Map stays compact.
- F98-02: against the pre-change `9cd1ae31dd`, all 65 Maps parsed and the AST (source positions removed) is identical; 505 evaluation results are equal; after restoring the Map strings and revision the whole config deep-compares equal. No values, match order, Provider or model capability change slipped in; no temporary layout script or new runtime formatter was kept.
- F98-03: SSR verifies the inherited placeholder and the personal value display as is. Pro isolated copy run `desktop-e2e-20260909-125010-082`, SC90-01 / F98-03 **2/2 pass**: editing an inherited value does not pin it; consecutive spaces typed into a personal Map are preserved; cancel writes nothing; save reads back as is; add-cancel writes nothing. Real 1200px / 390px screenshots confirmed controls do not overflow, the structural breaks stay, and the long ternary soft-wraps naturally in the textarea at narrow width.
- Added bug: before the fix, Pro `desktop-e2e-20260909-124116-723` logs showed `reorderPersonalModels` succeeding during typing and then the save failing with `expected 1 / current 2`; `desktop-e2e-20260909-124340-109` directly asserted two lost spaces. After 7 control/Portal component red tests, the existing interactive-target check isolates keyboard start; the 7 negative cases and the model-row keyboard positive case pass; the version check was not bypassed, no paste was simulated and no user Map rewritten to hide it.
- Local related Provider / Provider Node / Option Map / UI: **29 files, 422 tests pass**; root `pnpm typecheck`, `pnpm lint` (39 existing warnings / 0 errors) and diff checks pass. Tests and product code were updated together.
- Abstraction review: the UI shows only the source string and manages the draft, still submitting the Personal Overlay through the original Settings; the public Map compile, execution, Selection and persistence boundaries are unchanged. No extra state, subscription, retry or sync was added; the React change only filters the original event entry.
- Verification boundary: 390px is an Electron layout simulation, not a phone shared-host / real Web launch verification. The case stays pending without auto-promotion. The existing fixture checker does not support the settings spec domain; the manifest was added in the existing format and the real case passes, without extending the checker; original verification debt stays with Todo102 and was not advanced here.
