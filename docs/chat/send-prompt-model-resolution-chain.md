# Send Prompt Model Resolution Chain

Updated: 2026-07-15

> Historical chain audit, superseded by the Provider Refactor. The workspace Provider Registry push, `runtimeModel` fallback and the App/CLI dual catalog described here are no longer the current implementation. The current model is resolved by the target Environment's Model Selection, Registry and ModelFactory; see `docs/working-memory/provider-refactor/design/`.

V4 `sendText` carries no second UI decision about "which model this send uses". The model belongs to session config; send enters the same CLI session only after the config commands. Thus the toolbar, queue and runtime never keep mutually overriding model values.

## Overall chain

```text
toolbar config action ─┐
                      ├─> configCommandBarrier (linearizes user actions)
composer sendText ─────┘
  -> V4 command ACK/admission
  -> current session runtime config
  -> prompt turn
  -> ModelSelected/rows/snapshot projection
```

## Existing session

1. `SessionPane.dispatchSendText` puts the send into `configCommandBarrier`.
2. Model, thought, mode and follow-up commands enqueued before it must complete first.
3. The `sendText` payload carries only the text, ready attachment references and the explicit disposition of a held queue.
4. The CLI decides by the current `inputRouting`: start now, guide, enqueue or require a choice; the model is still the session runtime's current config.
5. The ACK proves only the admission result; the final UI settles on the conversation projection.

So "switch model -> send" uses the new model; "send -> switch model" cannot rewrite an already admitted turn. This guarantees only the same renderer's operation order; desktop continuous and web remote replayable are not merged into a global client FIFO.

## Draft first send

A draft has no formal session, so the model is established with creation:

- Prewarm session exists: align `draftConfigRef` to the prewarm runtime again before first send, then `sendText`.
- No prewarm: `createSession.config` carries provider/model/thought/mode/followupMode; with no attachments it can be submitted atomically with `firstInput`.
- After a successful first send the draft pane binds the returned sessionId in place; afterwards it only reads snapshot config.

Details: `docs/chat/new-task-model-resolution-chain.md`.

## Busy and queue

The V4 queue is decided inside the CLI command core; there is no old renderer-local conversation queue:

- `inputRouting.mode=enqueue`: accepted input enters the session's authoritative queue; the command does not copy the model.
- `inputRouting.mode=choice`: ordinary input must carry `heldQueueDisposition`, otherwise the UI asks for confirmation.
- A queued input runs with the runtime config already linearized and written to the session at that time.
- Stop/held/auto-drain product semantics are decided by the snapshot and CLI queue handler; the relay/main keep no queue.

So a model switch can affect queue items not yet started. The project has no product semantics of "each queued prompt pins the model at enqueue time"; docs and tests must not assume it.

## Provider recovery and failure

If a model config command returns `provider.notInRegistry`, the UI first syncs that workspace's provider registry, then resolves `runtimeModel` and retries exactly once. If recovery still fails, it does not go on to send a prompt that merely appears to use the new model; the send barrier surfaces the failure to the caller. A config noop may continue because the runtime is already at the target value.

## Code entry points

- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/configCommandBarrier.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts`
