# Todo 90: Unify Smart Configuration and Draft Behavior for Adding and Editing Models

> Later ruling (2026-09-11): [Todo130](todo-130-manual-model-config-editable-field-boundary.md) supersedes this document's rules on "disable the switch when the recommendation is not ready" and "manual whole-config pinning / completeness validation": only disable while saving, and manual mode requires only the editable fields while system fields keep resolving. **Todo130 is pending execution**; the old implementation and acceptance below are kept as history and do not mean the new semantics landed.

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implemented with joint Pro acceptance (§8). The recommendation hint copy is done (`8fba2cb9dc`). 2026-09-08. Baseline `c3e5fb37c2`, `provider-refactor-e2e-recovery`.

## 1. Goal and status quo

Adding a model can also use "Smart configuration" (formerly "follow recommended config"); add and edit share the config draft and interaction so the recommendation behavior no longer differs by entry. 2026-09-08 final addition: keep the switch (do not replace it with "restore defaults"); when off, the model ID no longer matches recommendations, all config is required, and no personal-override border shows. Mode, completeness and save belong to this item; final control styling is in [Todo92](todo-92-model-smart-config-and-override-feedback.md). This supersedes the earlier plan "pinned mode still resolves by the new ID first".

Confirmed gaps: (1) `ProviderModelMetadataDialog.tsx` shows the switch only for `mode === "edit" && inheritedConfig`, so even a matching add shows none; (2) the add chain passes only model config and never carries `useRecommendedConfig` (showing the switch without saving the mode is not enough); (3) editing the ID on add unconditionally clears the Context and Max Output inputs, edit does not, and the two draft-update paths were separate. Personal models may change their ID when editing (only inherited models are read-only), so the earlier claim "ID change is add-only" is withdrawn.

## 2. Confirmed product rules

### 2.1 Only the necessary differences

| Content        | Add                                                                 | Edit                                                 |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| initialization | new model draft, follow recommended by default                      | saved personal config, mode and this edit's baseline |
| model ID       | required, duplicate checked on save                                 | personal member editable; inherited member read-only |
| save effect    | create personal member and its config, mode, keeping existing order | update config, mode; atomic rename when ID changes   |

Recommendation resolution, mode switch, field editing, validation, cancel and keep-draft-on-failure are all shared; the `add/edit` identity is kept but is not a branch condition for the recommendation switch or config conversion.

### 2.2 Switch and draft

- The switch stays on the save/cancel action row, reusing existing i18n keys and Switch, renamed "智能配置" (`Smart configuration`); no "reset all" button. Description: "根据模型 ID 自动匹配推荐配置，允许单独修改。" (English in Todo92).
- Availability depends on whether the current ID has a resolved recommendation baseline, not on add vs edit nor Provider brand. With no ID yet or resolution not ready, show the switch default-on but disabled; when confirmed that no recommendation exists, no switch; not-yet-loaded is not mistaken for "no recommendation".
- Turning follow off fills the current draft's effective config completely into the editor-managed fields, keeping edited content and never copying the whole Provider/Account config.
- When off, all model config must be complete: real filled values shown, no recommended placeholders; empty numeric/Mapping never borrows `inheritedConfig`. `false` is a valid value and a legal `{}` is valid. Hidden capability and already-valid request config stay complete; unready fields do not forge a complete snapshot.
- Pinned mode neither looks up nor updates recommendations by model ID (changing the ID does not re-match); recommendation updates cannot affect pinned fields; server save and runtime resolution also never silently fill an incomplete pinned config from recommendations.
- Turning follow back on clears personal overrides within the editor-managed scope and restores the current ID's recommendation; fields edited afterwards still save normally (not cleared with the "restore recommended" action).
- Only the draft changes; Save persists, cancel writes nothing, failure keeps the draft; Todo 89's version conflict and no-duplicate-submit/close-during-save rules apply.
- Model enable/disable is not part of this switch: edit keeps the original `enabled`, add uses `enabled=true` at creation; no mode switch alters it.

### 2.3 Changing the model ID

```text
add / edit personal model: ID A -> B
  smart config on: resolve Provider + B recommendation; unoverridden fields use B's value; explicit personal overrides kept
  smart config off: no name-based recommendation; explicitly filled config kept; smart config not auto re-enabled
```

"Change ID" and "actively re-enable follow" are different actions: the former keeps personal overrides, the latter clears them. A personal override that happens to equal A's recommendation is not treated as no override: the basis is the personal draft, not a reverse guess from Effective values. Neither entry may clear Context, Max Output or other filled fields on ID change; pinned mode can save only a complete config that passes validation and never fills B's recommendation in secretly.

Async handling reuses the existing `useModelConfigResolution` (no second timer or retry):

```text
request A -> change to B -> request B -> B returns: apply; A late: discard
close dialog / switch Provider -> the original edit's requests expire
turn smart config off -> in-flight recommendation requests expire; no more name matching
save with mode on -> wait for the current ID's recommendation to resolve and validate -> atomic commit
save with mode off -> validate the complete personal draft / identity / version -> atomic commit
```

Boundaries covered: A->B->A, returning to the original ID, same ID with a different Provider, and on->off->on. Stale replies, stale recommendations or a previous dialog's result never join the current save; a failed resolution in mode-on keeps the input and allows retry/cancel; pinned mode saves a complete personal config even if the recommendation service fails, while identity, permission, duplicate-member and version checks stay.

### 2.4 Recommendation-match hint copy

2026-09-08 ruling: the Chinese text is "已匹配到智能配置" (replacing "已为模型匹配到推荐配置"), English `Smart configuration matched for this model`, reusing the i18n key `settings.modelProvider.modelDefaultsLoaded`. Copy only: no change to resolution, hint timing, follow mode or save.

## 3. Scope and state ownership

Layers: presentation, draft-default, validation, commit-effect, persistence; no session restore.

| Entry                       | Shared implementation / draft owner                                         | Recommendation and validation source                                            | Commit and persistence                                                                      |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| add model inside a Provider | ProviderModelsSection -> shared config editing logic/dialog; this new draft | target Host `resolveModelConfig`; shared draft conversion and server validation | `addPersonalModel` carries the config mode; ConfigService single Personal Repository update |
| edit personal model         | ModelRowInput -> same shared logic/dialog; initialized from existing config | same; keeps baseline revision and rename check                                  | `savePersonalModelDraft`; config, mode and any rename atomic                                |
| edit inherited model        | same, ID read-only                                                          | current inherited baseline; member permission independent                       | same model config save; inherited member identity unchanged                                 |

- Extract the really duplicated draft initialization, mode conversion, post-ID-change recommendation projection and commit validation; keep thin create/update entries, no generic CRUD or large form framework. The recommendation facts belong to the target Host; the Renderer holds only personal edit intent and the display draft, with no second Registry/Overlay resolver.
- The optional mode field flows from UI callback, hook, Settings Service, Facade to ConfigService; old callers default to follow. Reuse the existing mode metadata and completeness validation; creating the member, order, config and mode is one transaction. No `provider_config.json` format change, no migration, no mode in ModelConfig, request params or account state. The feature is unreleased, so no compatibility for "old pinned config"; `useRecommendedConfig` and related fields stay and are not renamed for UI copy.
- **Code simplification is a deliverable**: remove duplicated add/edit recommendation projection, mode switch and draft conversion; remove add/edit conditions without product basis (switch only on edit, add clearing numeric on ID change) while keeping initialization, member permission and create/update; clean up touched state, Effects, refs, callbacks, parameters, types, exports and fixtures that lost purpose (without deleting real personal-override records, stale-reply isolation, version checks or save protection); one fact has one source (not draft, resolved config and local Effective copy all writable); prefer a few clear conversion functions, extracting a hook only for a genuinely shared lifecycle; no registry/plugin-style form. The review lists what was deleted/merged and which branches must remain; the target is one rule and less duplication, not net deleted lines, and no incidental refactor of the whole settings module.
- Impact grading: must-inspect: both entries to one config editing logic (ProviderCardSections, ProviderFormControls, ProviderModelMetadataDialog), draft to recommendation resolution / commit conversion (useModelConfigResolution, ProviderModelMetadata), add/edit to the Settings write chain (InlineEditableProviderCard -> useModelProviders -> providerFacadeServices -> ProviderSettingsFacade -> ProviderConfigService -> Personal Repository); should-inspect: mode save to effective config / order / enabled (reuse existing pinned-config completeness check and Todo 89 write boundary, no inherited-member copying); conditional: narrow screen, theme, language, target Host (switch wraps sensibly on the same row; writes the target environment); invariant-only: Settings save to Selection/Session/account (only the existing post-save refresh; no change to model selection, connection switching, execution protocol or continuous/replayable). Codegraph unavailable: precise search and direct call-chain reading to the write boundary; the existing graph edges `surface.provider-settings -> service.provider-settings` and recommendation resolution are reused with this Todo's source link added; the implementation fork is recorded as a bug-candidate.

## 4. Acceptance plan

| ID     | Setup and action                                                                         | Must verify                                                                                                                                                                                                     | Evidence                                      |
| ------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| M90-01 | add: enter an ID that resolves a recommendation                                          | the switch appears on the save/cancel row; default follow; cannot go pinned before ready                                                                                                                        | DOM + Pro Electron                            |
| M90-02 | add: turn follow off, edit a field, save, reopen                                         | config complete, mode false; later recommendation changes do not alter pinned fields; member and order written once                                                                                             | service/config tests + Electron disk read     |
| M90-03 | add/edit: pinned back to follow, then edit a field and save                              | old overrides cleared, new edit kept; cancel saves nothing; original enabled not changed by mode                                                                                                                | parameterized tests + Electron representative |
| M90-04 | add and edit personal model, follow state, A to B                                        | unoverridden fields follow B; explicit overrides kept including one that equals A's recommendation                                                                                                              | shared logic + DOM                            |
| M90-05 | same, pinned state A to B, or clear a required field                                     | config and mode kept; no name-based recommendation call, no recommended placeholder/override style; an incomplete pinned config is rejected in UI and Host with no implicit B fill; `false` / legal `{}` usable | shared logic + service tests                  |
| M90-06 | delayed A reply, switch to B; also A->B->A, close-reopen, switch Provider, toggle off/on | only the current edit/identity/mode generation applies; pinned draft not overwritten by a late recommendation; save never uses stale resolution                                                                 | controllable Promise/hook/DOM (no sleeps)     |
| M90-07 | no recommendation, resolution failure, duplicate ID, version conflict or write failure   | no forged pinned config without a baseline; error keeps the draft; nothing partially written; inherited ID read-only                                                                                            | DOM + service fault tests                     |
| M90-08 | both modes save/cancel, narrow screen, zh/en, light/dark                                 | one interaction component usable; writes the target Host, other environments unaffected                                                                                                                         | Electron representative + service isolation   |

Pruning: inherited-model rename (existing ID read-only and server-side member protection, check it did not regress); all Account plans and ordinary Provider combinations (shared member write and draft rules; Account add and personal-model edit as representatives); real API/billing/Selection auto-switch (no behavior change, no real model requests); new formal state enumerations (a local form transaction suffices). No unruled scope; stop and discuss if a format change, account permission or a new auto-save becomes necessary. E2E timing uses normal UI condition waits; out-of-order resolution is proven by controllable-Promise unit tests; mobile/remote not run is stated, not replaced by a desktop narrow viewport.

## 5. Relation to other Todos

[Todo 82](todo-82-model-config-follow-recommended-draft.md) (existing mode field and draft save semantics kept; this item adds the add entry and tightens pinned mode to "no name matching / no inherited fill"); [Todo 88](todo-88-provider-audit-regression-repair.md) (follow-mode fix, config completeness, bottom layout, not re-forked); [Todo 89](todo-89-provider-settings-write-boundary-cleanup.md) (sparse member writes, narrow enabled operation, draft transactions and failure recovery); [Todo 92](todo-92-model-smart-config-and-override-feedback.md) (final override border, Hover/focus, MFJS and layout; no second mode or save rule).

## 6. Outcome

The hint-copy sub-item (§2.4) shipped in `8fba2cb9dc` (zh/en copy, the valid Settings spec, related tests and E2E comments; `providerModelMaxOutputLookup.test.ts` 12/12, `pnpm typecheck`, `pnpm lint` pass; no Electron rerun, so no desktop/mobile claim for the whole item).

### 2026-09-08 main execution, review and acceptance

```text
add / edit (only initialization, permission and create/update differ)
 -> useProviderModelDraft: Host recommendation baseline + personal raw input / source markers
 -> projectModelDraft / updateModelDraft -> resolveProviderModelDraftCommit
 -> Settings Service -> Facade -> Runtime assembly -> ConfigService single transaction
```

- Smart mode requests only the current Provider/ID baseline; numeric inputs and explicit source markers are not removed when equal to the recommendation; unoverridden controls follow the ID change while overridden values stay.
- Pinned mode materializes the current draft, keeping hidden facts (Audio, Tool Call, max-output Mapping); stops name-recommendation requests; empty numeric/Map is rejected in UI and the Host rejects incomplete config for add and edit with the same completeness check; model runtime resolution no longer fills from Built-in; enabled is independent.
- Turning on clears old model overrides (including the hidden max-output Mapping); later new edits are kept. The mode flows through all forwarding of the new member; config/member/mode save atomically; no file format or migration change.
- The existing idle/flush entries gain edit-generation identity and request-generation checks, covering A->B->A, close-reopen, switch Provider and off/on. Old responses never write the current draft; a complete pinned save does not depend on the recommendation interface; the body is inert and the footer submit locked while saving.

Deleted vs kept: add-specific touched ref, recommendation-field projection Effect, clearing numeric on ID change and `createProviderModelAddDraft` are deleted (replaced by the shared draft/source record); edit-specific `resolveCurrentDraft`, mode switch and reverse-derived override from whole-form validation are deleted (both entries consume the same hook and commit conversion); the create/update branches are kept (member permission, rename and revision checks are not duplicates); `useModelConfigResolution`, idle scheduling and server completeness validation are reused (no second retry or local Registry); the unused API-format parameter and redundant default-equality branch are deleted (actual format matching stays on the Host); the BooleanSwitchField wrapper and the icon-less checkbox visual branch are deleted (Todo92; MFJS uses the same BooleanModelOption).

Gaps found and fixed during execution: (1) Pro found Runtime assembly forwarded only the old four parameters and dropped the new mode; it now binds the full method signature and a real ProviderRuntime -> file -> Registry undefined/true/false parameterized test covers it (not proven by a Facade mock); (2) the recommendation preview must not inherit an old pinned-mode marker, so the Settings Facade's smart preview explicitly overrides the mode (formal storage unchanged); (3) merely focusing and leaving a level unchanged must not create a personal override (new regression test, no no-change onChange); (4) a WebDriver clear did not trigger the React input event, so the Pro test uses real key deletes and then verifies that empty input blocks saving (production validation not loosened); (5) the Todo92 narrow-screen screenshot showed the title clipped after focus (diagnosis and fix in that Todo).

Evidence and boundary: affected unit tests 24 files **317/317** (Provider full package, draft/edit/recommendation/style, real Runtime/Settings Service); `pnpm typecheck` pass; `pnpm lint` 0 errors, 40 existing warnings; `git diff --check` pass; knip's historical cleanup items remain (new shared implementation has production callers; no unrelated cleanup). Pro `desktop-e2e-20260908-105813-546`: SC90-01 and MP-UI-06 pass (new case really verified add pinned config, invalid draft, cancel not on disk, save-reopen, re-enable then edit, kept `enabled=false`; the old case still verifies edit, sort and Model Selection consumption). Pro `desktop-e2e-20260908-110410-575`: MP-UI-06 with the narrow-screen focus/title assertion passes, both themes zh/en screenshots read. The new case sits in `settings/manual-review/pending/provider-model-smart-config.test.ts` and was not promoted. Account members are covered by the shared write boundary and the Provider package tests, with a personal Provider as the Electron representative. 390px is an Electron narrow viewport and is not a real mobile remote verification; real Windows UI / account interfaces were not run; target-Host routing, continuous/replayable, session and account auto-selection and real user data are untouched. Final wider regression `desktop-e2e-20260908-110541-867`: 3 specs **9/9** (SC90-01, UP-01, MP-UI-01 to 06, Todo89 write-recovery entry), including the last shared-component cleanup and narrow-screen fix; final style/visual evidence in Todo92 §7.
