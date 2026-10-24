# Todo 92: Smart Configuration and Personal-Override Feedback in the Model Editor

> Background-feedback follow-up ruling (2026-09-11): [Todo132](todo-132-model-option-feedback-and-provider-name-edit.md) locally strengthens the selected/unselected background difference of square options so it stays distinguishable during Hover; text, icon, size and the border (which only marks overrides) are unchanged. That item is pending; the old style acceptance below is kept as history.

> Later ruling (2026-09-11): [Todo130](todo-130-manual-model-config-editable-field-boundary.md) supersedes this document's rules on "disable the switch when the recommendation is not ready" and "manual whole-config pinning / completeness validation": only disable while saving, and manual mode requires only the editable fields while system fields keep resolving. **Todo130 is pending execution**; the old implementation and acceptance below are kept as history.

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: final scheme implemented; Pro joint acceptance in §7 (2026-09-08). The Air's old group-restore preview is not final implementation or acceptance evidence. Mode and save are in [Todo90](todo-90-model-add-edit-shared-recommended-draft.md); the two are accepted jointly and do not each write their own draft logic.

## 1. Final ruling (replaces this round's intermediate scheme)

| Item                    | Final rule                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bottom switch           | kept, renamed "智能配置" (`Smart configuration`); still on the save/cancel row, left side                                                                 |
| description             | "根据模型 ID 自动匹配推荐配置，允许单独修改。" / `Automatically match recommended settings by model ID, with individual overrides.`                       |
| on                      | match and inherit the recommended config by model ID, personal overrides allowed; personal-override border shown                                          |
| off                     | the effective draft at the moment of switching is filled in completely; all model config required; no matching or fill-in by model ID; no override border |
| re-enable               | clears the model config's personal overrides and restores the recommendation for the current ID; later new edits can still be kept                        |
| save                    | mode switch and field edits only change the draft; persist on successful save, cancel discards, failure keeps                                             |
| identity / enable       | a mode switch never changes the model ID, list order or enabled; add keeps the creation-time enabled rule                                                 |
| global restore defaults | not added and does not replace the switch                                                                                                                 |
| group restore           | not added; the "自定义 · 恢复推荐" copy, group restore buttons and restore flags are all revoked                                                          |
| compatibility           | "not following" is unreleased: no old-data migration/cleanup; fields such as `useRecommendedConfig` may be reused, not renamed for copy                   |

"Required" means a complete config, not every capability on: boolean `false` is an explicit valid value and a legal Mapping `{}` is valid; an empty string cannot borrow an inherited value to pass pinned-config validation. Hidden fields must not be lost: turning off keeps Audio, Tool Call and the like from the effective config even without a UI control. 2026-09-08 copy ruling: the match hint is "已匹配到智能配置", consistent with the switch name; "推理参数 Mapping" becomes "推理参数映射" and the validation error "推理参数映射无效"; display copy only.

## 2. Border, background and layout

### 2.1 Personal override

- The border expresses two states only: no override = neutral thin border, override = light accent thin border; thickness, size and layout unchanged.
- It marks the personal config source, not "unsaved in this session": still marked after save and reopen, unmarked after the override is removed.
- It is derived from the current personal draft, not dependent on whole-form validation, and no writable highlighted state is introduced.
- An explicit override that equals the recommendation is still personal intent; equality of Effective and recommended values does not mean no override (consistent with Todo90's rule that changing the ID keeps personal intent).
- With smart configuration off no override style shows (not all required fields lit up together).

| Control                               | Override feedback scope                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| context window, max output            | each input highlights on its own, not the whole tokens container                                                                                                                                             |
| input types, model capabilities, MFJS | each option button highlights on its own; a recommended true changed to false must also be marked                                                                                                            |
| reasoning levels                      | `values` is one ordered config item: editing any name, adding, deleting or sorting marks all actual level boxes together (not one, not the outer container); the add button is not a level and is not marked |
| reasoning Mapping                     | its own input highlights; changing only Mapping does not highlight levels and vice versa                                                                                                                     |
| model ID, locked items                | not recommendation-override feedback; identity/read-only semantics kept                                                                                                                                      |

### 2.2 Hover and focus

- Hover and focus share a slight background change, not borders, and add no focus ring. Hover disappears on mouse leave; focus lasts until focus leaves; both together do not stack into a stronger third style.
- Option buttons keep expressing on/off by background; interaction background shifts on each state's base, so a Hover on an off option cannot look on.
- Keyboard Tab and text-edit focus must stay clearly visible; removing the ring does not mean removing every visible focus cue.
- Use DESIGN.md semantic tokens and verify light/dark; no fixed colors, no control size change, no global Button/Input override. Scope is the model editor's shared controls only (not site-wide inputs, other settings or the chat Composer).

### 2.3 MFJS and containers

- `BooleanModelOption` no longer decides a different control style by "has icon or not": with an icon show icon + text, without just text; the auto-drawn small checkbox for no-icon is removed together with its CSS/tests. MFJS uses the same button, selected and interaction feedback as model capabilities, with no icon or leading checkbox; keyboard operation and `aria-checked` accessibility semantics stay.
- The existing group frames stay; inside the reasoning frame are the level editor and the Mapping input with the duplicate "推理设置" title removed; Advanced settings keeps its title and independent container for MFJS; all outer containers keep neutral borders.

## 3. State and commit boundary

```text
add / edit initialization -> one personal draft + smart-config mode
 on: current Provider / ID recommendation resolution; recommendation only for inheritance/placeholder; personal overrides -> per-control borders
 off: complete personal config, no ID matching; changing the ID changes identity only, fields not refilled; no override border
 -> current draft display; save -> validate and write atomically; cancel -> write nothing
```

Before turning off the current draft can still be materialized from recommendations; after it, any empty field must report a concrete validation problem without silent filling. Turning off invalidates in-flight recommendation responses (a late result may not overwrite the pinned draft); re-enabling accepts only responses of the current Provider/ID/edit generation. Off-mode save does not wait for name-recommendation success, but identity, member permission, duplicate ID, version and completeness validation are not skipped. Provider/Account membership, credentials, permission and request-protocol resolution are unchanged ("no matching" refers to model-config recommendations, not bypassing these runtime boundaries).

## 4. Impact and responsibilities

| Entry                | Shared component / draft owner                                                  | Recommendation and validation                                                   | Commit                                                               | Mode and isolation                              |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| add model            | ProviderModelsSection -> ProviderModelMetadataDialog, Todo90 shared draft logic | smart mode follows the Host recommendation; pinned mode completeness validation | addPersonalModel -> Settings Facade/ConfigService -> Personal Config | Desktop/Web same component, target Environment  |
| edit personal model  | ModelRowInput -> same dialog/draft rules                                        | same; ID editable, version-conflict protection                                  | savePersonalModelDraft, atomic update/rename                         | other models untouched                          |
| edit inherited model | same dialog, ID read-only                                                       | same; Account/template member permission kept                                   | same config update entry                                             | account entitlement / connection mode untouched |

must-inspect: Dialog, MetadataFields, ModalityOptions, ReasoningLevelEditor, SettingsGroups default/hover/focus/override combinations; ProviderModelMetadata, ProviderFormControls, ProviderCardSections, useModelConfigResolution (Todo90 closes draft, mode and late-reply handling); should-inspect: pinned-mode server validation and final resolution (the UI must not show pinned while save/runtime still fill from recommendations); invariant-only: enabled, hidden capability, Provider/Account/Selection/Session and Desktop continuous / Web replayable; evidence-only: component tests, draft conversion, Host validation and isolated Electron with no real model requests. Codegraph unavailable (direct imports/callers at depth 2); no new surface or persistence owner, graph source docs updated only. Todo90 is the sole mainline for mode behavior/save/code simplification and this item for interaction and style: unify the draft first (Todo90), then add derived styles, then accept jointly.

## 5. Acceptance plan (the old G92 group-restore cases are voided; F92 are the new stable IDs)

| ID     | Setup / action                                               | Must assert                                                                                                                   | Evidence                       |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| F92-01 | smart on; change values / capabilities / input types / MFJS  | only the matching control's override border changes; a turned-off capability also gets override feedback; size unchanged      | component/draft + Electron     |
| F92-02 | change level name, count, order; and separately only Mapping | all actual level boxes marked together; Mapping independent; outer frame neutral                                              | parameterized unit + Electron  |
| F92-03 | Hover in/out, Tab focus, mouse leaves while focus stays      | same interaction background, no ring/border jump; switch background distinction kept                                          | real DOM/style + manual review |
| F92-04 | icon-less MFJS and icon capability options                   | shared button style, no leading checkbox; keyboard and aria state work                                                        | component + Electron           |
| F92-05 | smart off, clear a required field / change ID                | all fields explicitly filled and unmarked; an empty field blocks save without recommendation fill; false / legal `{}` allowed | joint with M90-02/05           |
| F92-06 | off then on, edit again and save; or cancel                  | on clears old overrides but keeps later new edits; cancel writes nothing; enabled/ID/order unchanged                          | joint with M90-03              |
| F92-07 | smart on, save and reopen; temporarily invalid input         | override source still visible; invalid numeric/Mapping does not drop other edit marks                                         | component + disk-read E2E      |
| F92-08 | zh/en, light/dark, 390px                                     | switch wraps on the same footer, labels/interactions do not overflow, focus visible                                           | Air visual + isolated Electron |

High-risk combinations and representatives, not every Provider brand or protocol; no model request, no real account file; Mac Electron isolated data verifies saving, and the phone-narrow viewport is not a remote-control chain verification. The new E2E sits in `settings/manual-review/pending` and is promoted after manual confirmation; old preview tests are not counted as passing.

## 6. Cleanup of earlier experiments (history)

The uncommitted group-restore UI, `resetGroupsValue` / group conversion helper, targeted unit tests and pending E2E, and the Custom/Restore recommendation experiment copy were withdrawn; the experimental MFJS/container tweaks were also withdrawn so only half the final design was not kept (removing the checkbox and title stayed on the to-do list). The committed predecessor fields/logic of smart configuration stay; Todo89 and the recommendation-hint copy commits are not rolled back. Old local/Air previews were moved out of the working locations (local `/tmp/zcode-retired-group-preview.6IUa9h`, Air `/Users/dev/.Trash/zcode-model-group-preview.oRYZZn`, recoverable, not launch entries). After cleanup: no diff in `packages/ui` and this desktop E2E scope against HEAD, two existing related unit files (43 tests) pass, `pnpm typecheck` passes, `pnpm lint` 0 errors / 40 existing warnings; graph YAML, unique IDs and seed paths check out, edges unchanged; the full desktop E2E was not rerun and nothing here claims the new scheme passed.

## 7. Final implementation and joint acceptance (2026-09-08)

| Scope                     | Implementation and evidence                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F92-01/07 override source | derived from the shared draft's personal intent; numbers and Map each read their raw input, booleans and modalities keep an explicit source, independent of whole-form validation; an invalid field does not clear other marks; pure function/component unit tests and SC90-01 disk-read reopen pass |
| F92-02 levels / Mapping   | all real chips marked together, Mapping separately with a neutral outer frame; the add button does not follow; merely viewing levels creates no override; keyboard sort, edit, add/delete and drag covered by unit tests, MP-UI-06 covers keyboard reorder and save-reopen                           |
| F92-03 Hover/focus        | `modelEditorControlStyle` serves only this dialog; the border reflects only override, Hover/`focus-visible` share one background and keep the selected / unselected base; Pro verified real hover in/out on MFJS and mouse-leave-with-focus: consistent background, no border jump; both themes pass |
| F92-04 MFJS               | the icon-less auto checkbox branch and the `BooleanSwitchField` wrapper deleted; `BooleanModelOption` reused with `role`/`aria-checked`, no leading icon/checkbox                                                                                                                                    |
| F92-05/06 mode            | shares mode, completeness, cancel/save with Todo90; the smart switch is in the footer, pinned state hides all override feedback; no new group/global reset                                                                                                                                           |
| F92-08 layout             | duplicate reasoning title removed, advanced title and two groups kept; Pro 390px light/dark, zh/en, control bounds, focus, title and footer verified (an Electron narrow viewport is not a real mobile remote)                                                                                       |

Real issue found by screenshot review: after switching from Chinese to English at narrow width, the original Dialog's `overflow-hidden` let focus scroll the outer frame (observed scrollTop=29.5, title top clipped); swapping the body element did not fix it. The outer frame became `overflow-clip` (clip only) with the body as the sole scroll area; no scrollTop reset, timeout or extra focus state masks it. New real-DOM assertions check the title is visible and the frame does not scroll; `desktop-e2e-20260908-110410-575` passes with both theme screenshots read.

Joint final regression, Pro `desktop-e2e-20260908-110541-867`, 3 specs **9/9**: the new pending `provider-model-smart-config.test.ts` (SC90-01); existing `settings-ui-polish.test.ts` (UP-01 and MP-UI-01 to 06, 7 items, excluding the explicitly SSH-requiring remote item); existing pending `provider-settings-write-recovery.test.ts` (recovery entry, add failure keeps the draft). Artifacts in Pro `/Users/dev/zcode-todo93-e2e.88xgST/packages/desktop/.e2e-artifacts/` (those runs' summaries; `todo90-92/model-editor-{dark,light}-390.png` are the final visual evidence). 317 related unit tests and root typecheck/lint pass (lint 40 existing warnings). No change to the global Button/Input styles, real user config, account/Selection/session/remote protocol; Windows, real mobile chain and every brand-account permutation were not run; the new E2E stays pending and was not promoted by the user.
