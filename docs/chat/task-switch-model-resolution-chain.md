# Model Resolution Chain After Task Switch

Updated: 2026-07-17

In V4 a task/session switch is a pane binding and topic subscription switch. The current model is no longer guessed by the renderer from task meta, message history and workspace defaults; `ConversationSnapshot.config` is the only display authority for a bound session.

## Switch and subscription

```text
sidebar sessions-index summary
  -> pane binds sessionId
  -> subscribe conversation/<sessionId>
  -> initial snapshot (or replayable recovery snapshot)
  -> ConversationProjectionStore atomic replace
  -> SessionPane / V4ComposerToolbar read snapshot.config
```

- `sessions-index` provides only list summary, phase and light interaction counts, not the full conversation config.
- The conversation snapshot contains rows, phase, config, inputRouting, actions and control; the UI does not assemble the new session's first frame from the old session's store cache.
- Snapshots are validated by subscription/generation/seq. A gap triggers recovery; a late online frame during recovery cannot overwrite the new snapshot.
- Desktop uses online continuous frames, mobile remote uses replayable recovery; the terminal snapshots are identical.

## Model display and recovery

Before the snapshot arrives the toolbar is not ready and does not pose the workspace default model as the historical session's model. After it arrives:

1. `snapshot.config.provider/model/thought` decides the current display.
2. Workspace `configOptions` provides only the selectable catalog and provider metadata.
3. The UI does not write back to the session based on whether a model is still "visible"; entitlement loading, menu filtering and ordering only affect catalog display.
4. If the current model was removed from the Agent workspace registry, the Agent picks a fallback by `default → last-used → catalog first` at an idle or next-turn admission safe boundary, and atomically projects model, actual thought and thoughtLevels via `ModelSelected`.
5. Before and after the snapshot arrives the renderer never sends the first menu item as an automatic switch; an explicit user selection goes through one `switchModelConfig`, settled by revision/CAS and the Agent projection.

On cold restore the CLI rebuilds the projection and runtime config from persisted message/part/session facts. `rowId`, the renderer store and the sessions-index summary are not model persistence authorities.

## Workspace and session isolation

- Existing session: the model comes from that session's runtime/projection.
- Draft pane: the model comes from the draft seed and workspace default until createSession establishes session authority.
- Switching sessions never writes the draft workspace default into a historical session.
- Workspace identity is `workspaceIdentity?.trim() || workspacePath`; remote recovery must also keep `remoteSessionId`, and subscriptions, caches or provider registry must not be reused by path alone.

## Reopen differences

Reopening may hit the local projection store's UI cache and display faster, but the subscription must still calibrate with an initial/recovery snapshot. Whether the CLI record is still in memory only affects recovery cost, not the model source; after a runtime epoch change the client must re-subscribe and must not keep sending on the old projection as authority.

## Code entry points

- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/conversationProjectionStore.ts`
- `packages/ui/src/v4/agentConversationTransport.ts`
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
