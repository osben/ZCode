# New Task Model Resolution Chain

> Draft creation, model and permission defaults, and the lifecycle of the uncategorized task directory are governed by the [unified design](../ui/project-task-draft-lifecycle.md): isolated per client, target host and project ID; the uncategorized pending directory is consumed after first send is accepted. The other organization-state and execution-directory constraints in this document still apply.

Updated: 2026-07-16

In V4 a "new task" is first an unbound draft pane. Model facts come from the renderer draft intent and the last-selected config seed; only after first send does the CLI session projection become authoritative. The old `createTaskWithSessionControl` and legacy `runtimeModel` first-send chain are no longer the UI main path.

## Draft config sources

Draft config is maintained by `useDraftConfigControl`:

1. Mode is read from the renderer's draft mode preference, not from the workspace catalog.
2. Model and thought prefer the global last-selected config tuple under that workspace identity.
3. Workspace `configOptions` provides the selectable catalog and validates the selection; when the catalog is not loaded, `prepareWorkspaceWithZCodeSessionService` hydrates it.
4. The user's explicit choice is written to the reactive draft intent and beats the initial seed and async catalog responses.
5. `followupMode` comes from the app setting and is passed with the create config.

The last-selected model and thought are an inseparable tuple:

- thought is filtered by the model's capabilities; a global independent thought is never applied to another model;
- a cross-model intent clears thought first, and the target runtime decides the actual default/compatible level;
- when the last model of an external custom provider is still available, the Z.ai/BigModel family connection memory must not overwrite it;
- when the last model belongs to the current family, Coding/Team Plan only constrains providers and available models within that family;
- when the current Plan provider is temporarily unavailable, do not fall back to an older connection of the same family.

All workspace-level isolation uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`; file and command execution still use `workspacePath`.

## Explicit selection and preference confirmation

A draft switch updates the intent first; with a prewarm session it then sends a V4 CAS to the explicit `targetSessionId`. Preference writes follow:

```text
draft intent: { model: B, thought: null }
  -> switchModelConfig(target prewarm session)
  -> accepted/noop: last-selected = { B, null }
  -> state.updated: last-selected = { B, actualThought }

synthetic empty thought ----------------X
failed/stale/superseded ----------------X
historical session snapshot ------------X
```

The pending intent is bound to the originating session; a late ACK or projection cannot overwrite a newer user choice. When the user explicitly selects a non-empty thought, accepted/noop commits the full `{ model, thoughtLevel }`. Automatic fallback, opening a historical session, app restart and background selected-key migration are not user selections.

A family connection switch in Model Settings is not a chat-toolbar model selection either: if the current draft uses a still-available model outside the family, the original draft session is kept; only when the draft belongs to the changed family or the current model can no longer be recognized is the unused deferred session closed and rebuilt for the target connection. A concrete model still available in the target Plan is kept.

## Prewarm path

The draft pane creates a pure in-memory, deferred draft session in the background:

```text
draft pane mount
  -> createSession { workspaceId, config: initialDraftConfig }
  -> CLI creates a deferred session (not in SQLite, not in sessions-index)
  -> conversation snapshot arrives
  -> if the draft intent changed, align config with CAS
  -> first send sendText
  -> promote, pane binds sessionId in place
```

If a prewarm session is unused when the user navigates away, `deleteSession` cleans it up. While create is still in flight, after the ACK arrives only a `deferred` session may be cleaned up conditionally; once first send has promoted it to `immediate`, a late cleanup must not delete it. Before committing a prepare result, re-check the pane/session binding so an old workspace response cannot overwrite an already created task.

## First-send path

By priority:

1. With a prewarm session: wait for the config barrier, then `sendText` on the prewarm session; promote and bind after accepted.
2. No prewarm, no attachments: `createSession { workspaceId, config, firstInput: { text } }`; config must apply before firstInput.
3. No prewarm, attachments ready: create an empty session first, then submit attachment references with `sendText`; clicking send does not start uploads.
4. Draft slash commands that need a session (such as `/goal`): reuse the prewarm session or create an empty session, then dispatch the command.

`buildDraftCreateConfigPayload` merges the current intent, the app follow-up setting and the synchronously readable initial config. The user's explicit draft value wins, so catalog hydration finishing later than an immediate first send does not fall back to the builtin model. First send passes through the same config barrier and cannot overtake the latest model/mode/thought command.

## CLI creation semantics

After creating a deferred session, `commands/handlers/session-mgmt.ts` calls `applyRequestedSessionConfig` before the first input:

- the requested config overrides runtime defaults;
- on a cross-model request, install/resolve the provider client and adopt the actual thought the target model supports;
- mode accepts only `build | edit | plan | yolo`;
- a non-default follow-up mode is written to the runtime;
- events such as `ModelSelected` / `SessionModeChanged` keep the projection cold-recoverable.

If config application fails the create ACK can still succeed, the session keeps runtime defaults and a warn is logged. So the UI prewarm and first-send barriers still check the config ACK and the final projection and must not trust only the local selector.

If the last-selected tuple can no longer be resolved in the current registry, the renderer does not write a separate fallback from the first menu item. `createSession` uses the available runtime default; if the registry changes after the session is created, the Agent runs the same fallback at an idle/next-turn safe boundary and calibrates the draft projection with a `ModelSelected` carrying the target model's actual thought.

## Multi-end boundary

Desktop and mobile attach to the same shared-host/CLI session facts; only topic delivery differs: desktop is continuous, mobile remote is replayable recovery. The relay/main create no second draft runtime and keep no draft model or session queue. Remote links must carry `workspaceIdentity` and `remoteSessionId` throughout.

## Code entry points

- `packages/ui/src/v4/composer/useDraftConfigControl.ts`
- `packages/ui/src/v4/composer/useDraftSessionPrewarm.ts`
- `packages/ui/src/v4/composer/draftGlobalModelSeed.ts`
- `packages/ui/src/v4/composer/modelConfigPreferenceConfirmation.ts`
- `packages/ui/src/hooks/workspacePrepareModelPreference.ts`
- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/lib/zcodeModelPreference.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`
