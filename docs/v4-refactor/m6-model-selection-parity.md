# M6 Model-Selection Parity: Completing the Input Box "Pick a Model" Logic

> **Status: implemented; kept as the M6 migration trail.** Current entry points are
> `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`, `useDraftConfigControl.ts` and the V4
> `commands/handlers/model-config.ts`; the old `ChatInputToolbar` paths below are only the audit baseline.

Principle continues `m5-composer-parity.md`: **old shell, new core**. Presentational parts reuse the old pure
components `ModelConfigSelect` / `ChatInputToolbar`; state orchestration and write paths are all v4 (read the
projection `snapshot.config`, write v4 commands, no bridge, new code does not call old).

Baseline: z-code-2 (online old version) `packages/ui/src/chat-input-toolbar/*`, `packages/ui/src/lib/*`,
`packages/ui/src/ChatInputToolbar.tsx`, `apps/zcode-cli/packages/*`. Current carriers:
`packages/ui/src/v4/composer/V4ComposerToolbar.tsx`, `SessionPane.tsx`,
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`.

M5 aligned only "what the selector looks like + values read from the projection"; the **selection logic
around the selector** (persistence / fallback / entitlement gating / connection mode / cross-provider
credential resolution) was missed entirely. The usage breakdown / cache-hit / usage panels registered in
`m5-composer-parity.md §6` are folded into Phase 4c.

Full history: `git show b8876e8b:docs/v4-refactor/m6-model-selection-parity.md`

## User rulings (2026-07-07)

1. **Scope = full alignment**, including Phase 1 (CLI provider credential resolution) and Phase 4b
   (connection-mode switching). Without that layer, the coding-plan list "click does not switch" and choosing
   a model of any other provider is decorative.
2. **"Remember last choice" = restore the old global semantics**: the ZCode-Agent model is remembered
   globally across workspaces, custom providers per workspace; includes legacy key migration.
3. **Implementation isolation**: edit/commit/test in the separate worktree `z-code-m6-model` (branch
   `m6-model-selection`, based on feature/v4-vertical-slice 52fb19e61), then cherry-pick/merge.

## 1. Gap list (capability, old implementation, v4 status)

**A. Remember last choice (persistence), real gap**

- last-model persistence (global key `zcode-last-agent-model`, ZCode-Agent `__global__`, custom per workspace;
  `lib/zcodeModelPreference.ts`): v4 only had workspace-default (per workspace) in `useDraftConfigControl.ts`.
- legacy key migration (workspace-scoped / path-only -> global): missing.
- thought-level persistence + GLM-5.2 default-max: missing.
- startup seeding + revalidation against the catalog (`chat-input-toolbar/modelSelection.ts`): partial, the
  draft falls back to workspace-default with no global seed/revalidation.

**B. Fallback / auto-positioning, real gap**

- Current model not in the selectable group -> first available / clear (`modelSelection.ts` + state machine
  in `ChatInputToolbar.tsx` + `setTaskVisibleModelListFallback`): missing, an invalid model does not self-heal and shows the raw id.
- Auto-select the family's first model after login (`resolveLoginProviderFirstModel`): missing.
- `<synthetic>` placeholder: missing, synthetic shown directly.
- Deferred positioning while entitlement hydrates: missing.
- Empty-config degradation: present (`SessionPane.tsx` + `modelMenuVisible` in `V4ComposerToolbar.tsx`).

**C. Coding-plan list correctness, partial gap**

- Group building + coding-plan grouping/badge (`lib/modelSelectionGroups.ts`): done via `buildModelSelectGroups`.
- **Entitlement visibility gating** (unauthorized not shown, start <-> coding mutually exclusive): missing,
  only `shouldIncludeModelProviderInSelection` filtered; `entitlements` only fed the start balance.
- **Connection-mode Select** (Start / Individual / Team / API Key; `ModelConfigSelect.tsx` +
  `onConnectionValueChange`): missing, `onConnectionValueChange` not passed.
- coding-plan usage panel, and context-usage breakdown + cache-hit: missing then (`m5-composer-parity §6` phases 2 and 1).

**D. CLI write-path provider / credential resolution (foundation of C), real gap**

- Switching a model resolves the provider client + credentials + connection mode to replace the runtime
  (`modelChangeActions.ts` + `useToolbarRecoveryModelChange.ts`): v4 `handlers/model-config.ts` said
  "credentials not done... only same-provider direct switch" and only called `app.setModel`.

**E. Polish:** `showManageModelsAction={false}`; `isItemLocked={()=>false}`; debug logs
`[v4-toolbar]/[v4-draft-config]/[v4-pane]`; the compression guard stays dead (revisit if needed).

## 2. Phased execution plan

Dependencies: **4b depends on 1**; the CLI side of 2 benefits from 1; 3/4a/4c are mostly independent.
Recommended order: **4a + 4c -> 1 -> 4b -> 2 -> 3 -> 5**.

- **Phase 1 (D):** CLI `switchModelConfig` gains provider/credential/connection resolution (authoritative,
  not resolved back on the client); `command.ts` payload additive `connection?`; missing credentials ->
  structured failed ACK; `applyRequestedSessionConfig` in sync. L2 + e2e.
- **Phase 2 (B):** CLI resume validation self-healing of invalid models + client hook `useV4ModelAutoPosition`
  (port the pure functions of `modelSelection.ts`: synthetic / first model after login / hydration deferral /
  invalid-model dispatch of switchModelConfig). L1 + e2e.
- **Phase 3 (A):** port the `zcodeModelPreference` global layer (key scope / migration / thought / GLM-5.2
  default-max); `useDraftConfigControl` as the draft seed; workspace-default keeps the per-workspace layer.
  L1 + e2e (after switching workspace the choice is still the last global one).
- **Phase 4 (C):** 4a entitlement gating (lightest, data in hand); 4b connection-mode Select (depends on 1);
  4c usage panel + breakdown/cache-hit (aligned with `m5-composer-parity §6`). Each with L1/e2e.
- **Phase 5 (E):** manage-models, running lock, log cleanup; the compression guard awaits a ruling.

## 3. Acceptance

- Each phase carries L1/L2 + e2e; first extend `docs/conversation-session-case-catalog.md` and
  `docs/testing/conversation-session-e2e-coverage-matrix.md`, then write the case.
- Discipline: no bridge in `zcode-protocol-v4/`; new code does not call the old protocol; protocol additive +
  sync `10-protocol-spec.md`; mark removable old paths dead and delete them.
- Before e2e: rebuild the CLI bundle with `node scripts/build-desktop-agent-cli.mjs`; `unset ELECTRON_RUN_AS_NODE`.

### Model trigger identity consistency (2026-07-13)

- Model selection identity is `provider + model id`; whether a switch happened is never judged by model name alone.
- The menu item and the collapsed trigger share one fact source, `modelSelectGroups + normalizedValue`: the
  trigger hits the menu item exactly by the full encoded value and shows that item's `name`. Do not take a
  display name from the provider config's `model.name` a second time (historical configs may keep an old alias
  that disagrees with the real model id).
- The collapsed trigger always shows only the menu item's model name; the provider is used only for menu
  grouping, exact selection and command identity, never in the trigger text, even when same-named models span
  several providers. Mobile Web remote keeps the existing compact truncation rules.
- When the current encoded value is not in the selectable groups, keep the Phase 2 synthetic / invalid-model
  placeholder logic; never expose the internal value.

```text
user clicks provider A / glm-5.2
  -> onValueChange(encoded(provider A, glm-5.2))
  -> CLI switchModelConfig -> snapshot.config(provider A, glm-5.2)
  -> rawModelValue = encoded(provider A, glm-5.2)
  -> modelSelectGroups hits the same menu item exactly
  -> trigger always shows only: glm-5.2
```

### Cross-model thought compatibility and command observability (2026-07-14)

- In a model-menu switch, the `thought` of `switchModelConfig` is the source model's current value; it does not
  mean the user also chose the same-named thought level for the target model. Across models/providers it must
  not be forced onto the target; the runtime chooses a compatible level from the global preference and its own
  capabilities, and `ModelSelected` must publish the runtime's final actual value.
- Only when provider/model are unchanged does `thought` mean an explicit thought-level switch; an unsupported
  value still fails, never silently masquerading as success.
- `createSession.config` may carry the thought left by the previous model. After applying the target model,
  override only when the target `listThoughtLevels()` explicitly supports it, otherwise keep the target's
  default level; a prewarm session must not be left half-done ("runtime switched, projection still old") by
  `Unsupported reasoning effort`.
- ACK, event projection and runtime must agree: once the model identity switches, publish `ModelSelected`
  with the actual thought; the whole command must not fail after the model changed because an attached
  thought is incompatible.

```text
source snapshot: GLM-5-Turbo / enabled
  | user selects only DeepSeek-V4-Flash
switchModelConfig(provider=deepseek, model=deepseek-v4-flash, thought=enabled)
  -> runtime.setModel(deepseek/deepseek-v4-flash)
  -> enabled treated as the source model's attached value, not forced onto the target
  -> runtime actual thought (target-compatible value, e.g. max)
  -> ModelSelected(deepseek/deepseek-v4-flash, max) -> accepted ACK -> snapshot/UI

same model, thought only:
snapshot model identity unchanged -> setThoughtLevel(user's explicit value)
  -> published on success / on unsupported the command fails and the model is unchanged
```

## 4. Progress

- [x] **Phase 4a entitlement gating** (`5c14a3927`): `filterModelProvidersByEntitlement` pure function +
      V4ComposerToolbar group building + 7 unit tests.
- [x] **Phase 3 global last-model persistence:** `seedDraftOptionsFromGlobalPreference` (draft catalog seed,
      revalidated against the catalog) + `useDraftConfigControl` writes global / first-send-consistent seed +
      `SessionPane` also writes global on a mid-session switch + 4 unit tests.
- [~] **Phase 2 fallback / auto-positioning (slice 1+2 done):** slice 1 trigger display (`<synthetic>` /
  unavailable model falls back to the placeholder "Choose model", `resolveModelSelectTriggerDisplay`); slice 2
  session-state invalid-model self-healing to the first available (`resolveV4ModelAutoFallback` pure function,
  8 unit tests, toolbar effect, entitlement-hydration exclusion + debounce guard). **Slice 3, auto-select the
  first model after login, is deferred** (v4 lacks a login event signal; `resolveLoginProviderFirstModel` is
  ready, wire it when the login surface is v4-ized).
- [ ] Phase 4c usage breakdown/cache-hit + usage panel.
- [~] **Phase 1 CLI provider/credential resolution (core done, `c9c67b061`):** 1c hybrid; the CLI overlay host
  capability (setModelCatalogOverlay -> setModel, no bridge) enables cross-provider switching; 4 new L2 + the
  no-bridge gate green. **Remaining:** 1a app-side re-push/resend edge fallback + e2e (see
  `m6-p1-runtime-model-resolution.md §7`).
- [ ] Phase 4b connection-mode switching (depends on P1).
- [~] **Phase 5 polish:** manage-models and running lock done; model trigger identity/display single-source
  fix done; other polish pending.

### Open follow-ups

- Phase 3 covers: draft selection / mid-session switch -> write global; new draft -> seed replay (across
  workspaces). **e2e pending** (after switching workspace the ZCode-Agent model is still the last global
  choice); extend the case catalog + coverage matrix first.
- The team-plan exemption of Phase 4a depends on `modelProviderFamilySelectedKeys` of `useSettings` (live
  config surface); connection-mode switching itself belongs to Phase 4b.
