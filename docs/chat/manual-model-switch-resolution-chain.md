# Manual Model Switch Resolution Chain

Updated: 2026-08-24

> Historical chain audit, superseded by the Provider Refactor. The workspace catalog, App Registry sync and `runtimeModel` recovery described here are no longer the current implementation. Current candidates come from the target Environment's Model Selection View; after a switch the same Environment's Registry/ModelFactory creates the Active Model. Current design: `docs/working-memory/provider-refactor/design/`.

This document describes the implementation in the V4 conversation main path. The old `ChatInputToolbar`, `useToolbarModelChange`, `session/setModel` and task stream path are removed and are not an implementation basis.

## Authority boundary

- For a bound session, the toolbar value comes from `ConversationSnapshot.config`; the model catalog comes from workspace `configOptions`. Model copy rule for the desktop toolbar, model-switch toast and chat marker: the Z.ai / BigModel built-in providers show only the model name (avoiding repeating the product's built-in connection name); other providers (including custom providers) show `provider.name/modelId` in a wide composer, keeping provider identity. The toolbar trigger is cropped by composer container width: icon only when extremely narrow, `modelId` only at medium width, full identity when wide. The model menu stays grouped by provider; toast, marker and model identity comparison are unaffected by this display cropping.
- The user selection is written to the CLI session through V4 `switchModelConfig`; the renderer does not modify conversation facts directly.
- The next real request uses the CLI runtime's current config; the snapshot only projects the authoritative result back to the UI.
- The renderer's last-selected `{ model, thoughtLevel }` tuple only seeds later drafts and never overwrites an existing session.
- Workspace `setDefault*` is kept for compatibility only; it is not a second selection authority for V4 drafts or bound sessions.

## Atomic Turn execution context

A started Turn fixes both its execution model and its stable context prefix. Updating a session's model, language or outputStyle while running only changes the next Turn's configuration; the current Turn keeps the model/context combination it started with. Assistant output, tool results, steering and runtime reminders produced inside the Turn may still append to the dynamic message tail under the existing flow and are not part of the stable context prefix.

```text
Turn N entry
  └─ capture model + stable context configuration A
       ├─ current request / tool follow-up / Compact retry -> A + context A
       └─ config update while running -> future config B, does not rewrite context A

Turn N+1 entry
  └─ detect context configuration A != B
       └─ rebuild context B, then issue the first request with model B
```

There are no separate pending flags for model, language and outputStyle; the runtime keeps one configuration snapshot matching the currently materialized context to decide whether the next Turn must rebuild. Manual Compact and ordinary Turns share the same lifecycle boundary.

## In-session switch

```text
V4ComposerToolbar
  -> SessionPane.handleSelectModel
  -> configCommandBarrier (serialized with sendText in user-action order)
  -> switchModelConfig { provider, model, thought, baseRevision }
  -> CLI commands/handlers/model-config.ts
  -> session model-config serial critical section
  -> app.setModel / app.setThoughtLevel
  -> ModelSelected { modelRef, supportedThoughtLevels, contextWindow, origin? }
  -> ConversationSnapshot.config + usage.contextWindow.maxTokens
  -> toolbar and preference seed settle
```

Key rules:

1. `provider` and `model` must both have values; empty values are not sent.
2. Cross-model switches do not reuse the source model's thought. The CLI lets the target model pick a compatible level and publishes the final actual value.
3. `thought` means an explicit thinking-depth switch only when provider/model are unchanged; a stale toolbar frame cannot write the old model's thought onto the new model.
4. A same-value switch returns `noop / config.unchanged`, not a faked accepted change.
5. Config commands carry the snapshot revision; when stale, `SessionPane` retries a bounded number of times based on `revisionAtDecision`, never unbounded replay.
6. Model and thought use a latest-wins scheduler and share a send barrier with mode commands; for "switch model -> send", `sendText` does not overtake an unsettled config.
7. The performance hint shows only when a bound session explicitly switches the `provider + model` identity; draft state shows no model-switch toast. A bound session shows no hint only when the provider/model tuple is identical. Toast identity comparison always uses the full provider/model tuple; for display, Z.ai / BigModel built-ins show only modelId and other providers show `provider.name/modelId`. Agent automatic fallback uses the same changed + warning copy, but only shows in the currently focused pane of a bound session when a live `online` frame first observes an A→B authoritative transition carrying a fallback origin. Draft prewarm, initial/recovery, historical snapshot, duplicate delta and background panes never show it. The model-change marker is still generated only by the CLI in the authoritative projection of a later turn of an existing session; the UI never inserts timeline rows itself. The marker carries start and end provider/model IDs; the renderer uses the same display rules, falling back to `providerId/modelId` when other-provider config is missing, and the marker must subscribe to the provider snapshot so names refresh in place when the catalog hydrates later or a provider is renamed.
8. create/resume/fork, legacy compatibility, registry fallback and provider runtime refresh must also pass through the same session critical section. `runtimeModel` is only a provider/header-derived cache and must not overwrite a user switch when its model or thought differs from the current runtime.
9. The Service rebuilds the runtimeModel cache by target only after this call's `accepted/noop`; `duplicate` does not mean the old command is still the current config and must not write the cache. Concurrent ACK cache rebuilds commit in Agent decision order; an earlier request that finishes last is discarded.
10. `contextWindow` is part of the applied runtime model capability and must be published atomically with `modelRef`, actual thought and `supportedThoughtLevels` through the same `ModelSelected`. After switching models in a historical session, the projection keeps the existing `usedTokens` and immediately switches `usage.contextWindow.maxTokens` to the target model; it does not wait for the next `ModelComplete`, and the renderer must not derive another denominator from the workspace catalog.
11. A model command on a running session must not replace the whole adapter registry just to prepare a provider client. If the target model is already in the current session overlay, only the next turn's session selection updates; the latest workspace overlay applies at the ready boundary. If the target exists only in a not-yet-applied new catalog, the command explicitly returns `provider.notInRegistry` and must not succeed at the cost of disposing an in-flight signer; retry after the current turn ends. Request-level runtime headers do not follow this config-command semantics.

## Two-phase confirmation of the user preference

The ACK usually arrives before `state.updated`. To stop a new draft inheriting the source model or thought in between, an explicit model selection commits the same last-selected tuple in two phases:

```text
user selects model B
  -> pending intent (bound to targetSessionId)
  -> accepted/noop ACK
       -> save { model: B, thoughtLevel: null }
  -> authoritative projection of B
       -> save { model: B, thoughtLevel: actualThought }

historical session projection --------X no explicit intent, no preference write
late ACK/projection of model A -------X cannot overwrite a newer model B/C intent
empty thought from a controlled Select X synthetic change, not fed to the scheduler
```

- The pending intent is bound to the originating session; another historical session that happens to have the same model cannot confirm it.
- If the projection arrives before the ACK, the authoritative write completes and pending clears; a late ACK must not downgrade the actual thought to `null`.
- When the user explicitly selects a non-empty thought, accepted/noop commits the complete target model + thought tuple directly.
- `failed`, `stale` and `superseded` do not update the user preference. Automatic fallback is not written to renderer preferences directly by the Agent; only in the callback where the projection store applies the same live `online` fallback event for the focused pane, with no explicit model intent in flight, the actual model tuple is promoted by compare-and-set. Ordinary snapshot differences, initial/recovery/historical projections and the first full online snapshot that establishes a subscription's applied base never write the preference.

## Provider registry auto-recovery

When the target provider is not in the CLI workspace registry, the first command returns `provider.notInRegistry`. `SessionPane.switchModelConfigWithRecovery` recovers exactly once:

```text
failed(provider.notInRegistry)
  -> sync provider registry by workspaceIdentity / remoteSessionId
  -> zcodeSessionService.resolveRuntimeModelForV4(...)
  -> retry once with runtimeModel and the latest revision
  -> settle on success; stop (no loop) if it still fails
```

Remote workspaces must carry `workspaceIdentity` and `remoteSessionId` throughout. This recovery only fills in the provider client overlay and does not change the delivery boundary between desktop continuous and mobile replayable.

## Draft-state switch

In draft state, a reactive draft intent is written synchronously first, and thought is cleared immediately on a cross-model switch. A draft has no real conversation yet, so ordinary selection, custom-provider recovery and Agent prewarm fallback show no model-switch toast. Then it branches on prewarm state:

- When `configOptions` fails, a real custom provider goes through restart/force-prepare recovery but only updates the draft selection and runtime preparation state, with no performance hint.
- Existing prewarm session: run the V4 CAS against that explicit `targetSessionId`.
- No prewarm session yet: the intent is left for the later `createSession.config`.
- Prewarm projection arrives: only re-project fields that still differ; an old snapshot must not mask the new intent.
- Before first send: `ensureDraftPrewarmConfigBeforeSend` waits for the latest config barrier.

```text
old: compare modelId                  new: compare providerId + modelId
    A/glm-5.2 -> B/glm-5.2              A/glm-5.2 -> B/glm-5.2
              └─ no hint                          └─ draft state still no hint

catalog / draft intent / projection
              -> Toolbar effectiveConfig (identity visible at click time)
              -> onSelectModel(sourceModel, targetModel)
                   └─ CAS keeps using SessionPane's latest snapshot revision
```

The Target Host's ModelSelectionView only provides the selectable provider/model/reasoning display projection. The last-selected tuple updates only after an explicit action is confirmed by ACK/projection; opening a historical task, catalog hydration and background connection migration must never write it back.

The chat marker's display path shares the same identity format as the toast but does not change when the marker is generated:

```text
Turn N actually used provider-A/glm-5.2
  -> ModelSelected(provider-B/glm-5.2)
  -> Turn N+1 started
  -> CLI marker { fromProvider: A, fromModel: glm-5.2,
                  toProvider: B,   toModel: glm-5.2 }
  -> renderer subscribes to the provider snapshot
  -> built-in Z.ai/BigModel: "模型已切换 glm-5.2 → ..."
     other providers:         "模型已切换 B-name/glm-5.2 → ..."
```

The protocol and CLI projection keep the full provider/model tuple, and the chat renderer must consume it (not just `fromModel/toModel`) so same-named models of custom providers stay distinguishable. The renderer keeps subscribing to the existing provider snapshot and retains provider names for other providers; the Z.ai / BigModel built-ins omit the fixed entry name per the product copy rule. With the catalog missing at first, other providers fall back to the provider ID and re-render in place after hydration or rename. The full start/end identity and projection timing of a normal A→B marker are unchanged, as are the desktop continuous / mobile replayable delivery semantics; the next section only adds the source-less branch for the explicit `∅→X` model boundary.

### Subagent first actual model

A normal Main session's first selection only establishes the model baseline and generates no marker. A fresh Subagent child is the only exception: after resolving inherited, `lite` or explicit profile override, the child runtime writes the actual `childModelRef` to both the live event and the persisted timeline.

```text
resolveEffectiveSubagentModelRef -> childModelRef X
  |-- ModelSelected(previousModelRef=null, modelRef=X) -> live projection
  `-- model_change(fromModel=undefined, toModel=X) -> transcript

first TurnStarted
  -> modelChange { fromProvider/fromModel absent, toProvider/toModel=X }
  -> renderer: no switch icon + "正在使用 X" / "Using X"

cold hydration
  -> source-less model_change synthesizes previousModelRef=null
  -> first TurnStarted rebuilds the same marker exactly once
```

- A missing `previousModelRef` only updates the current config and does not change the turn model baseline; an explicit `null` means the `∅→X` boundary. The public projection consumes only the boundary and does not know Subagent identity; a fresh child is merely the only live producer of that boundary today.
- The turn model baseline has three states: ordinary Main first turn (silent), explicit source-less, and previous turn's known model. Multiple selections do not overwrite the previous turn's actual model: `A→B→C` shows `A→C` next turn, `∅→X→Y` shows `Using Y` on the first turn.
- V4 `modelChange` keeps the existing destination tuple. Its source provider and model are jointly present for A→B switches or jointly absent for Subagent initial usage; half-present source tuples are invalid.
- Source-less markers use the same provider/model display formatter as the destination side of normal switches. Z.ai / BigModel omit the fixed provider name; other providers keep `provider.name/modelId` and fall back to the provider ID until catalog hydration. They omit the switch icon and the redundant trailing "model"; normal A→B markers keep the existing switch icon and wording.
- Only fresh child sessions persist this initial timeline fact. `resumeFromStore` does not write it again, and histories created before this contract are not inferred or backfilled.
- The marker stays child-owned and is not mirrored into the parent Agent card or parent conversation timeline. It does not update last-selected preferences and produces no model-change toast.

## Agent fallback for unavailable models

The UI-visible catalog is affected by entitlement hydration, filtering and menu sorting, so it must not be used to rewrite the session. Once the latest workspace provider registry takes effect, the Agent is the sole decider of automatic fallback:

```text
registry removes the current model
  -> active turn: keep the in-flight request, wait for a safe boundary
  -> idle / next-turn admission
  -> pick an available model by default -> last-used -> catalog first
  -> app.setModel (resolve the target's actual thought)
  -> ModelSelected { modelRef, supportedThoughtLevels, contextWindow,
                     origin: "registryFallback" }
  -> ConversationSnapshot.config + usage.contextWindow.maxTokens
  -> toolbar read-only display
  -> the focused pane first observes the event in a live online frame
  -> reuse the manual switch's changed + warning toast
```

Concurrency with an explicit switch is linearized by the order of entering the Agent critical section; whoever enters later re-reads the current runtime:

```text
fallback C enters first -> user B enters later -> final B
user B enters first     -> fallback re-reads, B available -> no-op, final B
stale runtime A arrives late -> mismatches current B / thought -> dropped, no event published
```

- The renderer no longer dispatches an "automatic" `switchModelConfig` from the first menu item, so catalog loading/reordering cannot overwrite the user's in-progress explicit selection.
- With no available model, the Agent keeps the current value and lets later admission surface the unavailable error. "Available" here means only that registry/catalog can resolve it, not a real provider network probe.
- Automatic fallback is not written to last-selected preferences by the Agent; the focused pane may promote the actual config by compare-and-set when it consumes the same live authoritative transition and no explicit model intent is in flight.
- The automatic hint does not guess its origin from any A→B `config` difference. The CLI marks only registry-fallback `ModelSelected` with `origin`; the V4 projection keeps a stable event ID and start/end provider/model; the renderer store dedupes by event ID after successfully applying a live `online` frame and notifies the focused pane. `initial`, `recovery`, historical snapshot and duplicate/gap frames only update the observed baseline and never toast; if initial is lost, the full `online` snapshot arriving next is just the first applied base for that subscription and may only seed the observed baseline. Only a new `online` transition after the base is established triggers both the pane's toast and the preference CAS, so reopening a historical task, mobile reconnect or relay recovery replays no old hint and rewrites no selection. Desktop and mobile consume the same Agent model fact and decide locally whether to show it over their own delivery chain.
- An `online` transition is a one-shot, non-replayed event. `SessionPane` must install the transition listener synchronously in the same effect that obtains the session lease, before the subscribe activation releases initial/online frames; it must not `setLease` first and register on the next effect. Keep-warm store re-entry follows the same order. The listener gap must not be compensated by reading or replaying `snapshot.modelTransition`, otherwise initial/recovery/historical transitions would be mistaken for live events.

## Not yet implemented

V4 currently has no guard for "target model context window smaller than used context: stop/compress before switching"; current code allows switching models on a running session. The pending semantics follow `docs/superpowers/specs/2026-06-10-model-switch-context-window-guard-design.md`; catalog items N05 and N09–N14 stay marked planned, and the old legacy implementation plan must not count as current coverage.

## Code entry points

- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/configCommandBarrier.ts`
- `packages/ui/src/v4/composer/modelConfigPreferenceConfirmation.ts`
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`
- `packages/ui/src/lib/zcodeModelPreference.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `packages/shared/src/zcode-protocol-v4/rows.ts`
- `packages/shared/src/zcode-protocol-v4/command.ts`
