# M6 Phase 1: CLI Provider/Credential Resolution (runtimeModel), Historical Design

> **Status: superseded by Provider Refactor; kept only for the option choice and migration trail.** The
> current norm is that the target Environment's Provider Registry and ModelFactory create the Active Model;
> `workspace model catalog`, the `runtimeModel` fallback, `workspace/updateProviderRegistry` and credential
> snapshot delivery have left. Current facts: `docs/working-memory/provider-refactor/design/`.

Purpose: complete the foundation of v4 "switching a model only supports same-provider direct switch", so that
**cross-provider / connection-mode switching** takes effect in the runtime. Continues
`m6-model-selection-parity.md`; the user ruled full alignment while keeping the default fallback and the
coding-plan logic.

Full history: `git show b8876e8b:docs/v4-refactor/m6-p1-runtime-model-resolution.md`

## 0. Key finding

**The app never hand-builds a runtimeModel.** The old toolbar only pushed a "model ref selection"; the real
`runtimeModel` (credentials / endpoint / Start-Plan JWT header / Team-Plan projectId+key / official-version
safety-check header / thought narrowing) was resolved lazily from the app's provider registry snapshot by the
**live service layer** (`packages/services/.../zcodeAgentService.ts` + `modelProviderService.ts`) at every RPC
dispatch. That service layer is shared infrastructure, not the deleted UI toolbar, and not in the CLI
`zcode-protocol/` forbidden zone, so v4 can reuse it whole. Keeping coding-plan and the default fallback is
nearly free: reuse the service resolver/registry snapshot, do not rewrite.

## 1. Facts

**CLI side (apply primitive + fallback)**
- The v4 handler `commands/handlers/model-config.ts` only called `app.setModel(formatModelRef)`: it re-selects
  within the current registry and does not change the provider client.
- The primitive that really changes the provider client (callable natively by v4): **`record.app.setModelCatalogOverlay(overlay)`**
  (installs a provider registry with credentials -> `modelAdapter.replaceRegistryConfig`,
  `app/model-catalog-overlay.ts`) **then `app.setModel(...)` + optional `setThoughtLevel`**. The overlay is
  built by `createModelCatalogOverlay(catalog, env)` (`zcode-protocol/workspace-model-catalog.ts`) from
  `context.workspaceModelCatalogs`; the catalog is pushed by `updateProviderRegistry`.
- **No-bridge rule** (`bootstrap/tests/v4-native-boundary.test.ts`): the v4 directory must not import any
  `zcode-protocol/` path (including server-operations **and** workspace-model-catalog), but `record.app.*` /
  `record.app.runtime.*` are freely callable. The binder `v4-bridge.ts` lives in the old directory and may
  legally import the workspace-model-catalog primitives, so overlay construction is injected as a host capability.
- **CLI fallbacks to keep** (outside the apply write path, untouched by this phase):
  `reconcileResumedRuntimeSettings` (`runtime_model_authoritative` + `persisted_model_unavailable` keeps the
  current value and warns), `derivePersistedRuntimeSettings`, `ensureSessionModelAvailableForNextTurn` (**already
  bound as the v4 `ensureModelReady` hook**), `DEFAULT_MODEL` / `createModelConfigMissingError`.

**App/service side (runtimeModel resolution + coding-plan + fallback)**
- Two layers: toolbar (`modelChangeActions.ts` three handlers: push model-ref + decide restart + push
  registry) -> service (`zcodeAgentService.ts`: `runtimeModel = params.runtimeModel ?? await resolveRuntimeModelConfig(...)`,
  lazily resolved from `modelProviderService.getProviderRegistrySnapshot()` and sent with the RPC).
- Shared resolution engine, **reuse, do not rewrite**: `resolveRuntimeModelConfig`, `createRuntimeModelConfig`,
  `modelProviderService.buildProviderRegistrySnapshot`.
- **coding-plan / start-plan / team-plan credential injection lives in the service layer (keep):**
  `pickResolvedFamilyProvider` (Start / APIKey / Coding / Team connection pick),
  `buildStartPlanRuntimeAuthorizationHeaders` (Start Plan `Authorization: Bearer <jwt>`),
  `resolveSelectedBigModelTeamPlanRuntimeApiKey` (Team Plan org/projectId + project key), the helper that
  strips the official-version safety-check one-shot header, `resolveSupportedRuntimeThoughtLevel` (drop thought
  if the target model does not support it), the Team Plan removal guard (a filtered provider throws
  unavailable, never silently falls back to a personal key).
- `runtimeModel` schema (`shared/zcode-protocol/index.ts` `zcodeModelRuntimeConfigSchema`): `{revision,
  generatedAt, model{providerId,modelId,variant?}, provider(providerId,kind,apiFormat?,baseURL?,apiKey?(inline/credential/env),apiKeyRequired?,headers?,providerOptions?,models[]...), thoughtLevel?}`.
- Service contract: `IZCodeAgentService.setModel({..., model, runtimeModel?, modelProviderFamilySelectedKeys?})` /
  `updateRuntimeModelConfig({..., runtimeModel, applyModelSelection?})` / `updateProviderRegistry({..., registry})`.
- App fallbacks to keep: `resolveRuntimeModelConfig` built-in fallbacks (history missing -> undefined so the
  agent recovers; provider removed -> throw unavailable; stale default -> first available in the registry).
  Toolbar-side `resolveUnavailableModelListFallback` / `resolveLoginProviderFirstModel` / `<synthetic>` /
  context-window guard / recovery path belong to **Phase 2**; this phase does not do them but the design must not block them.

## 2. Core design: 1c hybrid (user ruling 2026-07-07)

Three options for getting runtimeModel (with credentials) into the CLI; **1c hybrid chosen**: normally 1b (the
CLI resolves from the already-pushed registry); when the provider is not in the registry (just added / race /
remote) fall back to 1a (the app resolves runtimeModel and pushes it with the command). This implements the
user's wording "prefer app-supplied (registry) / otherwise the CLI's current value / updates sync (re-push)".

- **1a push runtimeModel on every switch:** the app reuses the service resolver and puts runtimeModel into the
  `switchModelConfig` payload (additive `runtimeModel?`, heavy schema); a host capability merges
  `runtimeModel.provider` into the catalog + builds the overlay + setModel. Closest to the old version
  (legacy `session/setModel` always carried runtimeModel), most stable, supports remote; but credentials ride
  every command and the v4 protocol couples to a heavy schema.
- **1b the CLI resolves from the already-pushed registry:** the app sends only `{provider,model}` (status quo)
  and guarantees the registry is pushed (re-push on connection/credential changes); a host capability builds
  the overlay from `context.workspaceModelCatalogs` + setModel. Cheapest, closest to v4 "CLI authoritative";
  depends on registry freshness.
- **1c hybrid (chosen):** normally 1b; when the provider is not in the CLI registry fall back to 1a with
  runtimeModel (additive `runtimeModel?`, used only for the fallback). The host capability uses the payload's
  runtimeModel if present, otherwise builds the overlay from the registry, and throws unavailable when both
  are missing so the app re-pushes and retries.

Implementation order: 1b core loop first (CLI resolves from the registry), then layer the 1a fallback (app
resolves runtimeModel + resend on `provider.notInRegistry`).

## 3. Implementation (1c)

**Layer A: v4 protocol (additive)**, `packages/shared/src/zcode-protocol-v4/command.ts`
- `switchModelConfig` gains optional `runtimeModel?`; the schema reuses `zcodeModelRuntimeConfigSchema` from
  `@zcode/shared/zcode-protocol` (a reference inside the shared package, not a CLI service bridge; a v4 mirror
  may be defined if the coupling is too heavy, see §5).
- `createSession.config` may carry it too (first send uses the right provider); `applyRequestedSessionConfig` consumes it.

**Layer B: CLI binder + handler**
- `commands/types.ts` `V4CommandCoreHost` gains the capability
  `resolveAndApplyRuntimeModel(sessionId, { model, runtimeModel? }): Promise<{applied:boolean, reason?}>`
  (transitional hook, retires when the config surface is v4-ized, same tier as `ensureModelReady`).
- `v4-bridge.ts` coreHost implementation (old directory, legal): payload has runtimeModel (1a fallback) ->
  `applyRuntimeModelConfigToWorkspace` merges into the catalog; otherwise take the pushed registry from
  `context.workspaceModelCatalogs.get(workspaceKey)`; `syncAppWorkspaceModelCatalog` ->
  `app.setModelCatalogOverlay(overlay)`; provider missing -> return `{applied:false, reason:"provider_not_in_registry"}`
  (no throw; the handler emits a structured ACK so the app re-pushes and retries).
- `handlers/model-config.ts` `switchModelConfig`: call `host.resolveAndApplyRuntimeModel(...)` **before**
  `app.setModel`; `applied:false` -> `failed` ACK (reasonCode `provider.notInRegistry`), never silent; the rest
  keeps setModel/setThoughtLevel/emitModelSelected. `applyRequestedSessionConfig` is wired the same way.

**Layer C: renderer/service (app side)**
- 1b normal: keep the registry fresh with the existing `updateProviderRegistry` push; **re-push on
  connection-mode change (P4b) / provider add** (aligned with the old `syncModelProviderRegistryBeforeCustomModelWrite`).
- 1a fallback: expose the service resolver to v4: `IZCodeAgentService` gains
  `resolveRuntimeModelForV4({model, modelProviderFamilySelectedKeys})` (thin wrapper over the existing
  `resolveRuntimeModelConfig`, **zero rewrite of coding-plan/fallbacks**); SessionPane `handleSelectModel`
  resolves runtimeModel and resends once on a `provider_not_in_registry` receipt.
- Keep the toolbar fallbacks (Phase 2 main body; this phase must not block them): the context-window guard
  confirm/compress when switching to a smaller-window model in a session (`modelSwitchContextWindowGuard`,
  reserve 64k); the restart-runtime decision (non-GLM external agent types need a restart when switching
  models, **GLM does not**, so v4's main GLM path rarely triggers it).

### 3.1 Phase 2 app fallback closure semantics (2026-07-09)

Phase 2 restores only two old behaviors, not the whole old toolbar state machine:

```text
user selects a model
  -> SessionPane sends switchModelConfig(provider, model, thought)
  -> CLI ACK: failed/provider.notInRegistry
  -> app force syncWorkspaceModelProvidersToAgent(force=true)
  -> app calls the service resolver to resolve runtimeModel
  -> SessionPane sends switchModelConfig(provider, model, thought, runtimeModel) again
  -> the second ACK is the final result, no loop
```

- `provider.notInRegistry` auto-recovers only once. If the second attempt still fails, keep the original
  failed ACK and log for the existing error UI/debug buffer.
- The app only syncs the provider registry and attaches `runtimeModel` to this retry; it changes no stream,
  snapshot, queue or replay semantics.
- Desktop stays the `desktop-continuous` real-time link; mobile `/remote` stays the `web-remote-replayable`
  recovery link. The provider registry is workspace config control-plane data; replayable recovery messages
  must not be spliced into desktop continuous, and mobile must not bypass the replayable gap/snapshot boundary.
- A remote/split pane must pass `remoteSessionId` to the provider registry sync; the identity/isolation key is
  `workspaceIdentity?.trim() || workspacePath`, and the execution path still uses `workspacePath`.

Restoring a custom provider choice when prepare/configOptions failed:

```text
workspace configOptionsStatus=error
  -> user can still click a custom provider value in the model menu
  -> app writes last-selected + selectedSupplierKey=custom:<providerId>
  -> app writes the workspace default model
  -> app restartWorkspaceProcess(bumpRuntimeEpoch=true)
  -> app force prepare/readWorkspaceState
  -> configOptions refilled, model menu recovers
```

This path serves only prepare-failure recovery; it does not restore the old full `modelSwitchStage` UI,
context-window guard, cross-provider busy-lock details or the old restart decision matrix.

## 4. Retention checklist (acceptance)

- **coding-plan / connection mode** (kept by reusing the service resolver): Start Plan Authorization header,
  BigModel Team Plan org/projectId + project key, the official-version safety-check one-shot header
  (`applyModelSelection:false` sub-agent path, an edge case, TODO), family connection pick, thought narrowing,
  no silent fallback after Team Plan removal.
- **Default fallback:** CLI resume `reconcileResumedRuntimeSettings` (two bugfixes) + `ensureModelReady` +
  `DEFAULT_MODEL` / missing error (unchanged); service `resolveRuntimeModelConfig` three fallbacks (history
  missing / removed / stale first-available).
- **P4b coordination:** the connection-mode Select `onConnectionValueChange` = write
  `modelProviderFamilySelectedKeys` (AppSettings) -> registry cache invalidation -> re-push (1b normal path
  takes effect) or resolve the new connection's runtimeModel and resend (1a). After P1, P4b ~ only adds
  "write the family key + trigger re-push".

## 5. Decisions

1. 1a/1b/1c: **1c hybrid decided (2026-07-07).**
2. v4 command `runtimeModel` schema: **lean to reference the shared `zcodeModelRuntimeConfigSchema`** (DRY, a
   shared-package reference rather than a CLI service bridge) with a source comment; switch to a v4 mirror if
   the coupling proves too heavy during implementation.
3. Official-version safety-check one-shot header (Start Plan sub-agent, `applyModelSelection:false`):
   **TODO in this phase, not wired** (edge case on the sub-agent safety-check path).

## 6. Tests

- L2 (v4 CLI): cross-provider switch -> overlay applied -> `getModelRef` changes provider; provider not in the
  registry -> structured `provider.notInRegistry` ACK; same-provider direct switch still takes the existing
  path; the two resume reconcile fallbacks regress.
- L1: the service resolver thin wrapper passes through (coding-plan/team-plan snapshot hits do not regress; reuse the existing modelProvider tests).
- e2e (batched, run exclusively): pick a custom-key provider model -> projection config changes provider + a
  real turn; switch connection mode (after P4b lands).
- First extend `docs/conversation-session-case-catalog.md` + the coverage matrix.

## 7. Implementation progress (1c)

1. Done: **v4 protocol additive** (`command.ts` `runtimeModel?`, referencing the shared schema), commit `c9c67b061`.
2. Done: **CLI binder host capability** `resolveAndApplyRuntimeModel` (v4-bridge reuses workspace-model-catalog
   overlay construction, no-bridge compliant) + types.ts interface.
3. Done: **CLI handler** (switchModelConfig/applyRequestedSessionConfig call the capability before setModel;
   `provider.notInRegistry` -> structured failed ACK).
4. Done: **L2 + no-bridge gate** (4 new cases + 6 existing applyRequestedSessionConfig signature migrations;
   model-config 18 / v4-commands 13 / shared-schema 8 / boundary all green; CLI turbo typecheck 20/20).
5. In progress: **app fallback (1a), Phase 2 closure.** The normal 1b path is enough (the registry is pushed at
   workspace prepare, the CLI catalog has all configured providers, so `catalog.providers.has` hits and the
   cross switch takes effect). 1a covers the desync edge "provider in the app but not pushed to the CLI"
   (just added / race / remote): SessionPane receives `provider.notInRegistry` ->
   `syncWorkspaceModelProvidersToAgent({ force: true })` re-pushes the registry -> service
   `resolveRuntimeModelForV4` resolves runtimeModel -> `switchModelConfig` retries once with runtimeModel.
   On prepare/configOptions failure only the custom provider choice, workspace default write, restart + prepare
   are restored, not the old global stage UI.
6. Pending: **e2e** (batched, exclusive): pick a custom-key provider model -> projection changes provider + a
   real turn, validating the 1b normal-path loop.

> The P1 core (CLI enablement of cross-provider switching) is done and backed by L2; the 1a edge fallback and e2e are wrap-up items.
