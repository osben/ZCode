# Model Resolution Chain Audit

Updated: 2026-07-17

> Historical audit, superseded by the Provider Refactor. It records the pre-migration App Provider Snapshot, `runtimeModel` fallback and workspace catalog chain, not the current implementation. Current model facts come from the target Environment's Effective Provider Config, Model Config Rules, Provider Registry and ModelFactory; see `docs/working-memory/provider-refactor/design/`.

It summarizes four chains and the remaining complexity and gaps:

- `docs/chat/task-switch-model-resolution-chain.md`
- `docs/chat/new-task-model-resolution-chain.md`
- `docs/chat/manual-model-switch-resolution-chain.md`
- `docs/chat/send-prompt-model-resolution-chain.md`

## Conclusion

V4 removed the old main path where UI task config, task meta, workspace default, session snapshot and runtimeModel cache jointly decided the current model. The boundary is three layers:

```text
draft preference / workspace provider registry
  -> createSession.config or prewarm-session CAS
  -> CLI session runtime config (the only write authority)
  -> ModelSelected (shared by user switch and registry fallback)
  -> ConversationSnapshot.config (read-only projection)
  -> V4 toolbar
```

For an existing session the model authority is the CLI runtime; the draft preference only sets a new session's initial value; the UI catalog only decides what is selectable. Send carries no separate model, and config and send are ordered through the same barrier.

## Complexity that must stay

| Complexity | Why kept | Boundary |
| --- | --- | --- |
| workspace provider registry | custom provider credentials and model metadata live on the app/service side | synced by workspace identity and remote session |
| one-shot `runtimeModel` fallback | installs a client overlay when the CLI registry has not seen the new provider yet | retry once, only after `provider.notInRegistry` |
| service `runtimeModel` derived cache | provider header/capability hot refresh needs the model runtime config | rebuilt in decision order after accepted/noop; duplicate does not write; Agent validates model+thought; it must not carry switch intent |
| draft prewarm | avoids creating a session at first send and slow workspace default writes | deferred, in-memory, cleaned up if not promoted |
| draft global seed | a new draft continues the user's last choice | must not override this draft's explicit selection |
| Agent registry fallback | a historical session whose model was removed from the registry can still continue | Agent decides by default, last-used, catalog first and publishes the projection; the UI does not write |
| config command barrier | prevents "switch model -> send immediately" reordering | linearizes only this renderer's admission; no cross-client global FIFO promised |

## Removed old fact sources

These may still appear in 2026-06 historical plans, test migration notes or compatibility adapters but no longer decide the V4 conversation's current model:

- the active-task branch of `ChatInputToolbar` / `useToolbarModelChange`;
- resume-hint resolution in `useZCodeChatSendPrompt`;
- `taskConfigOptionsByTaskId` as conversation config authority;
- the renderer-local busy prompt queue;
- `session/setModel`, `workspace/setDefaultModel` as V4 session write entries;
- deriving the toolbar's current value from the last message model or task meta.

`zcodeSessionStore` still serves the workspace shell, task list, unread, compatibility service projection and draft directory; that does not mean it still owns the V4 conversation transcript or session config.

## Verified invariants

1. A bound session's toolbar value is confirmed only by snapshot config.
2. An explicit draft selection beats the asynchronously hydrated global seed.
3. `createSession.config` applies before `firstInput`; a prewarm session is aligned again before first send.
4. A cross-model switch does not force the source model's thought onto the target.
5. A same-value config is noop; stale revisions retry a bounded number of times; provider registry recovery retries once.
6. `sendText` carries no second model selection; queued input does not pin the model at enqueue time.
7. Desktop continuous and mobile replayable share session facts but keep different delivery/recovery mechanisms.
8. The relay and desktop main hold no conversation business state such as model, queue or snapshot.
9. Automatic fallback after provider registry invalidation is decided only by the Agent; the UI model menu is a catalog projection and does not write the first menu item back to the session.
10. Automatic fallback and manual switch share `setModel -> actual thought -> ModelSelected`; model, thought and capability catalog are never published separately.
11. create/resume/fork, legacy write, V4 write, registry fallback and runtime refresh share the same session model-config critical section; a stale runtimeModel that disagrees with the current model/thought can only be ignored, never written back as selection.

## Open gaps

- The context window switch guard is not migrated back to V4; a running session can currently switch models directly.
- `createSession.config` application failure means "session created, config degraded to runtime default". Deviations surface only through the UI barrier, logs and later snapshots; an accepted create must not be simplified to "the specified model was definitely applied".
- Multiple clients configuring the same session converge only via revision/CAS; there is no product semantics of one client permanently owning the model selection.

## Audit entry points

- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`
- `packages/ui/src/v4/composer/useDraftSessionPrewarm.ts`
- `packages/shared/src/zcode-protocol-v4/command.ts`
- `packages/shared/src/zcode-protocol-v4/snapshot.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
