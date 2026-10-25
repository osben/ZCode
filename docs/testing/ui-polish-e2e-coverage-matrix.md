# UI Polish E2E Coverage Matrix

- Logo style migration: UP-00 verifies the old Windows settings-page position, the 18px base and the 11px static SVG. Windows run passed: `desktop-e2e-20261009065931122-p21208-9f6085045aa4ea21`, 1/1; light and dark screenshots checked.
- 2026-10-09 platform sizes: UP-00 on the Windows settings page passes for the 6px outer edge, 8px radius and top-right action group alignment, run `desktop-e2e-20261009070918592-p12424-e7971ff15e21066b`.

## Todo153: thought-level display and configured order

Based on the [control spec](../ui/chat-thought-level-control.md) and [Todo153](../working-memory/provider-refactor/steps/todo-153-thought-level-display-mapping.md). The browser candidate is `packages/ui/test/browser/manual-review/pending/thought-level-display.test.mjs`; the fixture uses the real shared control, SubagentReasoningField and the toolbar shortcut hook with an isolated settings service and sends no model request.

| Case  | Setup and action                                                                                                                                          | Assertions                                                                                                                                                                                    | Status                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| TL-01 | One config holds off, minimal/low, max/ultra, extra-high/extra_high, default; desktop 1200 / touch phone 390, zh/en, light/dark; open the menu and select | Copy matches the spec; aliases with the same name are not de-duplicated; default keeps its source name; menu respects configured order and submits the raw value; no overflow in the viewport | accepted; 8 browser combinations pass, awaiting human promotion |
| TL-02 | Same sizes and themes: operate the select menu, click-cycle, Ctrl+T and the Subagent field                                                                | They share configured order and wrap to the start at the end; the shortcut does not open the menu; Subagent shows the same copy and submits the raw value                                     | accepted; 8 browser combinations pass, awaiting human promotion |

Covered by targeted component unit tests: off in the middle, unknown value named off, empty/invalid values, single-level read-only. Browser screenshots serve visual checks only. The group does not represent full Electron, mobile remote reconnect or provider request chain verification and is not auto-promoted to the formal desktop E2E.

## 2026-09-12 current whole-page verification

This section replaces the retired AddProviderCard footer / smart-toggle position described further down. MP-UI-01 verifies the four Zhipu template groups, returning to the original selection, DeepSeek's two default members, atomic creation and going straight to the detail; MP-UI-04 deletes from the Provider more menu and confirms navigation and Personal are removed together; MP-UI-06 verifies real edit, cancel, save, level sorting and the two vision-marker entries against the current help title, identity-row smart toggle and restore button layout.

Pro final `provider-20260912-pro-settings-polish4`: WDIO reports 9 passing / 1 skipped, where UP-00 returns early on macOS and **does not prove Windows**; 8 actually executed items pass, the SSH case is skipped for missing environment. Earlier failures were not product regressions: the test missed the menu / help title / final DeepSeek catalog, and UP-01 left a menu open so later wheel events were blocked by the modal pointer barrier. Tests fixed, the full scroll assertion kept, product unchanged. MP-UI-01 alone also passes.

390px zh/en light/dark edit screenshots were checked: title, groups and action buttons are within the viewport, the Map stays multi-line and the body scrolls independently. This is not a real-device mobile shared-host run.

## Todo98 source Map layout

F98-03 (accepted, pending, not promoted): reuse `settings/manual-review/pending/provider-model-smart-config.test.ts`; add/edit reads the real multi-line Built-in Map with desktop and 390px screenshots; real typing of consecutive spaces does not trigger background sorting, cancel writes nothing, and a normal save reads back unchanged. Pro `desktop-e2e-20260909-125010-082`: SC90-01 / F98-03 **2/2 pass**. F98-01 scans the structural line breaks and simple ternaries of every real Built-in Map; F98-02 passes for all 65 ASTs and 505 evaluation comparisons; there is no runtime formatter. 390px is layout simulation only, not real mobile remote. Added keyboard isolation has 7 control/Portal negatives and a positive for keyboard launch on a model row.

## Feature summary

Todo103 candidate regression: the Hover/keyboard-focus color comparison in MP-UI-06 must wait for the control's existing CSS animation to finish and then read the final computed style. A transition frame is not the recommended style, and the test is not made to pass by deleting animations, loosening color assertions or longer fixed sleeps. The original 2026-09-09 Pro run captured Hover alpha=0.047 and focus final alpha=0.05, a test sampling race; product styling and the original ruling are unchanged.

| Field                 | Value                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Change                | Profile menu preference order; model-provider empty and add-provider states                    |
| Change layer          | Presentation + provider connection validation                                                  |
| Operating mode        | implementation-handoff                                                                         |
| User-visible surfaces | Desktop sidebar profile menu; desktop/web model-provider settings                              |
| Existing specs        | `docs/desktop/sidebar-zoom-menu.md`, `docs/model-provider-family-merge.md`                     |
| Out of scope          | Model request traffic, mobile replay recovery, remote workspace runtime, provider billing APIs |

## Impact brief

### UI surface matrix

| Scenario                                 | UI entry                                    | Shared implementation               | State owner / source                      | Validation / gating                                                   | Commit sink                                          | Mode boundary                                      | Isolation invariant                                                      |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Inspect preference order                 | Sidebar avatar menu                         | `WorkspaceSidebarFooter`            | React props + desktop zoom platform state | Zoom is desktop-only                                                  | Existing theme/locale callbacks and desktop commands | Order is shared; zoom remains desktop-only         | Opening the menu must not mutate preferences                             |
| Inspect add-provider guidance            | Settings > Model provider > Add provider    | `AddProviderCard`                   | Local add-provider draft                  | Add action disabled until required fields and a model exist           | Existing model-provider service create action        | Responsive desktop/web layout                      | Hint must not create a second validation rule                            |
| Delete the final editable provider model | Settings > Model provider > Custom provider | `ProviderModelsSection`             | Model-provider registry                   | Empty list is allowed for an existing provider                        | Existing provider update action                      | Desktop/web share UI; no replay semantics involved | Empty models remove chat candidates while preserving the provider editor |
| Resolve a zero-model Coding Plan         | Provider family connection resolver         | `resolveCodingPlanEntitlementState` | Model-provider registry                   | Connection requires credential + endpoint, not a non-empty model list | No UI mutation                                       | Shared pure resolver                               | Empty models must not disconnect entitlement                             |

### Ranked relationships

| Rank           | Relationship                                           | Reason                                                                            | Evidence                                        |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| must-inspect   | Provider settings -> model-provider service            | Deleting the final model persists through the existing provider update path       | `ModelProviderSection`, `ProviderModelsSection` |
| must-inspect   | Coding Plan visibility -> provider connection resolver | The regression was caused by treating `models.length` as a connection requirement | `providerFamilyConnectionVisibility.ts`         |
| should-inspect | Add-provider footer -> add-provider draft validation   | Guidance and disabled action must agree                                           | `AddProviderCard.tsx`                           |
| conditional    | Profile menu -> desktop zoom commands                  | Zoom appears only in Electron desktop mode                                        | `WorkspaceSidebarFooter.tsx`                    |
| invariant-only | Provider settings -> chat model picker                 | Zero models means no selectable chat model, without changing plan identity        | `docs/model-provider-family-merge.md`           |

### Codegraph evidence

The repository declares `surface.provider-settings -> service.model-provider` as a `must-inspect` edge in the feature graph. No live codegraph tool is available in this checkout, so depth-2 verification uses direct imports/callers and existing E2E helpers. The sidebar profile menu is a graph-drift candidate because its preference surface is not declared in the curated feature graph; this task does not change its state or persistence contract.

## Boundary decisions

| Decision                         | Status   | Included                                                                        | Pruned / reason                                                                                                                                           |
| -------------------------------- | -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UP-01 profile menu order         | accepted | Visible top-level order in desktop mode                                         | Theme and locale value changes: existing behavior, unchanged by this branch                                                                               |
| MP-UI-01 add-provider footer     | accepted | Divider, info hint, DOM/visual left-right order, disabled action                | Provider request/send: already covered by P0-02                                                                                                           |
| MP-UI-02 empty editable provider | accepted | Delete the final custom-provider model; empty hint and Add Model remain visible | Coding Plan models are server-synced/read-only, so zero-model connection stays resolver-unit coverage; Team/Start/Z.ai variants are pairwise unit-covered |
| Locale variants                  | pruned   | One runtime locale plus exact zh/en locale unit assertions                      | Layout uses the same message id and responsive flex contract                                                                                              |
| Theme variants                   | pruned   | Semantic classes asserted by unit test                                          | No theme-specific branch or raw color was added                                                                                                           |
| Mobile/remote runtime            | pruned   | Responsive class contract remains unit-covered                                  | No process, protocol, replay, owner, or workspace identity change                                                                                         |

## Accepted cases

### System Prompt Settings editor

`SP-01` (accepted, manual-review pending): in an isolated desktop E2E HOME, open Settings -> System Prompts; assert the eight editable sections appear: the six main-prompt sections in ContextBuilder invocation order, followed by memory-extraction and memory-dream; edit and save one section, confirm the Customized state and diff/effective text, then restore the default and confirm the customization marker clears. Protected prompt fragments must not appear as editable entries. Keep this candidate under `settings/manual-review/pending/` until human review; it does not enter the default Electron or Docker gate automatically. Local/remote service selection, dirty-draft host switching and remote disconnect are covered by UI hook tests because a live SSH host is not a hermetic Settings-only fixture for this case.

Plan-loss switching, Todo93 C93-01-12 (implemented / verified, 2026-09-08): a same-identity plan invalidation is hinted only once and switches only after clicking a concrete target. Covered: repeated refresh, identity switch, startup baseline, unknown/pending, stale button race and conditional write failure. The old Todo88 R06 / SPMC-08 expectation "refresh switches automatically" is replaced; historical passes do not prove the new contract. The chain coverage is kept with a real click and assertions of no write before the click / on-disk read after it; Pro desktop-e2e-20260908-101239-586 4/4 pass. Full scenarios and isolated E2E handoff: [Todo93](../working-memory/provider-refactor/steps/todo-93-account-plan-loss-manual-switch.md).

Final ruling (2026-09-08): the Todo92 G92 group-restore case and the `provider-model-group-reset.test.ts` experiment are withdrawn. The formal plan is Todo92 F92-01-08: personal-override borders expressed per item, levels as a whole with Mapping independent, Hover/focus on the same background, no leading checkbox for MFJS, container title converged; verified together with Todo90 M90-01-08 for "smart config" on/off, all required, no name matching, cancel and save. Implemented to the final contract and the joint acceptance passes; the old Air preview does not count as evidence. No "自定义 · 恢复推荐" (customized, restore recommended) is shown and no group or global restore button is added.

Todo 89 W89-05/W89-08 (accepted, 2026-09-08): a personal model in the isolated config lacking contextWindow can still be opened for edit, saved to repair, enabled/disabled and deleted in settings; a duplicate add is rejected by the real write entry, the dialog and input are kept after failure, and members cannot duplicate. Protection against deleting inherited members is covered by DOM/service cases. New pending `settings/manual-review/pending/provider-settings-write-recovery.test.ts` does not become a formal gate before human review. The config source is the config-parse snapshot, not just the executable Registry; an unrepaired model must not appear in executable selection. This follows Todo89 and the current Provider spec, not the old Service/read-only account model description in this page's historical table. Actual run records: Todo89 acceptance table.

Todo 88 / R08, R13 correction (2026-09-07): the model edit dialog keeps two always-visible groups: "推理设置" (reasoning settings) with levels and Mapping, and "高级设置" (advanced settings) with MFJS; it is not the old collapsed advanced area. The follow-recommended switch sits in the save/cancel action row and on small screens wraps within the same form-action component. MP-UI-06 additions: turn follow off then cancel, reopen still follows; turn off then save, reopen stays fixed with the original edits; switch fixed back to follow then edit Mapping, save and reopen keep the new value. Real persistence is verified, not just draft or CSS. Still covered: long model IDs with prefix/suffix, zh/en and light/dark themes, the 390px edit layout; after saving with image capability on, both the settings model row and the normal selection menu show the vision marker. The new verification awaits a Pro run and is not counted from the old evidence below.

| Case     | Setup                                 | Action                 | Assertions                                                                                             | Evidence                     | Status   |
| -------- | ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- | -------- |
| UP-01    | Desktop workspace ready               | Open avatar menu       | Language, theme, zoom appear in the committed top-level order                                          | Electron DOM + unit          | promoted |
| MP-UI-01 | Default provider settings             | Open Add provider      | Four Zhipu templates grouped; template/custom creation opens persisted detail; outer page scroll works | Electron DOM/geometry + unit | promoted |
| MP-UI-02 | Custom provider starts with one model | Delete its final model | Empty dashed hint and Add Model action remain visible                                                  | Seeded files + Electron DOM  | promoted |

## Coverage goal

- Every changed branch in `providerFamilyConnectionVisibility.ts` is covered by unit tests.
- Every added render branch and class contract in `AddProviderCard.tsx` and `ProviderCardSections.tsx` is covered by unit tests and one real Electron path.
- The sidebar order is covered by an Electron DOM-order assertion; callback and desktop zoom command behavior remain covered by their existing tests.
- Targeted V8 coverage is measured for the four changed source files. `100%` is a goal for changed lines and branches; unreachable framework/bootstrap code is reported rather than hidden.

## E2E handoff

- Formal spec: `packages/desktop/test/e2e/settings/settings-ui-polish.test.ts`
- Provider fixture: none; the case seeds local provider/settings files and performs no model request.
- Timing: ordinary UI waits (`fast-text` equivalent), no stream timing.
- Docker preset: settings/default desktop suite after manual review and promotion.
- Human review confirmed on 2026-08-19; settings-domain promotion completed without conversation fixtures.

## Runtime evidence

- Formal Electron run after promotion: `desktop-e2e-20260819044246639-p7031-0eaf856fbfb1eeae`, 3/3 passed without `ZCODE_E2E_MANUAL_REVIEW`. Artifact: `packages/desktop/.e2e-artifacts/desktop-e2e-20260819044246639-p7031-0eaf856fbfb1eeae/summary.md`.
- Electron manual-review run: `desktop-e2e-20260819042607776-p64629-52e741b6f1da02f5`, 3/3 passed (UP-01, MP-UI-01, MP-UI-02). Artifact: `packages/desktop/.e2e-artifacts/desktop-e2e-20260819042607776-p64629-52e741b6f1da02f5/summary.md`.
- No provider request is made, so no replay fixture or timing class is required.
- Targeted V8 run covered 100% of executable lines added by this branch in the four changed source files; whole-file percentages are intentionally not presented as 100% because those components contain unrelated legacy paths.

## Todo90 / Todo92 final execution evidence (2026-09-08)

Pro `desktop-e2e-20260908-110541-867`: 3 specs / 9 cases pass. The new pending case SC90-01 covers adding a fixed mode, empty-input rejection, cancel writing nothing, edit-reopen and keeping the disabled state. The original MP-UI-06 keeps verifying edit, level sorting, Mapping and Model Selection consumption, extended with 390px dual-theme/zh-en and Hover/focus, and non-clipped title assertions. UP-01, MP-UI-01-05 and the Todo89 W89-05/08 repair-entry regression also pass.

M90-01-08 and F92-01-08 are jointly covered by 317 related unit tests and the representative Electron cases above; the full case pruning and unverified ends are in Todo90 §8 / Todo92 §7. Source lifecycle, identity and failure injection use controlled Promise / real Runtime write tests and do not duplicate every account-brand combination. The new case stays at `settings/manual-review/pending/provider-model-smart-config.test.ts` and is not auto-promoted. Pro screenshots `packages/desktop/.e2e-artifacts/todo90-92/model-editor-{dark,light}-390.png` were checked; they are not the old Air preview and not real mobile remote verification.

## Menu radius migration (2026-09-04)

Source spec and historical run evidence are from fixed staging; the full Todo103 candidate still needs the shared regression, and the historical pass is not inherited for this one.

- Spec: [DESIGN.md Radius](../../DESIGN.md#radius).
- Scope: shared DropdownMenu, ContextMenu and Select expanded panels use `lg`; items (including checkbox/radio items and submenu triggers) use `md`; submenu shells restart at `lg`. Select triggers are unchanged.
- Accepted: UP-01 additionally reads computed radii from the opened profile menu (8px shell, 6px items at the default root size). Shared component contract tests cover all three implementations and submenu variants.
- Desktop and mobile Web share these primitives and theme-independent radius utilities. No process, clientMode, deliveryKind, stream or recovery behavior is added.
- Separate mobile and cross-OS visual runs remain outside this targeted desktop check.

Verification:

- Red: the new shared-radius and business-override contract tests failed against the old styles.
- Green: 22 targeted unit tests passed; `pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e` and `pnpm lint` passed (41 existing lint warnings, no errors).
- macOS Electron: `settings-ui-polish.test.ts`, 3/3 passed, including computed menu shell/option radii. Run: `desktop-e2e-20260904075731227-p32863-d53541f289639947`.
- Windows caption and automation/off-peak menu overrides were removed so these surfaces inherit shared radii. ContextMenu, Select, checkbox/radio items and submenus have contract coverage; their individual runtime paths and mobile/Windows/Linux visual checks were not run.

## macOS root frame background (2026-09-04)

UP-01 on macOS adds an assertion that the `DesktopWindowFrame` computed background is transparent. This is the historical verification record of the transparent root-background rule at that time; the current root-background rule is in [DESIGN.md](../../DESIGN.md#color-usage-rules), and this historical pass is not treated as current behavior. Unit tests cover the macOS, Windows, Linux and Web background branches. Only the root background style changed; child-area backgrounds and remote-control behavior did not.

- Verification: the macOS unit test failed before the change and all four platform-branch unit tests pass after; repo-wide typecheck, E2E typecheck and lint pass (41 existing warnings, 0 errors).
- macOS Electron: 3/3 pass, root frame computed background is `rgba(0, 0, 0, 0)`; run ID `desktop-e2e-20260904082702490-p81892-0a8af92f6cb52575`.
- The Windows/Linux/Web background branches have unit tests but no standalone platform visual verification; the settings and error pages reuse the same component and were not screenshotted individually.
