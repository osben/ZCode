# Conversation Product Projection: Current Implementation

Updated: 2026-07-15

`ConversationProductProjection` is the CLI's conversation read model for App/Web. Product semantics follow [conversation-product-protocol.md](../conversation-product-protocol.md); the wire schema follows `packages/shared/src/zcode-protocol-v4/`. This document explains how current code generates and recovers the projection from runtime facts.

## Authoritative chain

```text
runtime SessionEvent / persisted transcript
  -> event-normalizer.ts             unifies live/cold canonical facts
  -> ProductProjection               reduces control/config/queue/rows etc. product state
  -> ConversationTopicPublisher      produces snapshot/delta, seq, logEpoch
  -> Host connection scope           only subscription ownership and frame forwarding
  -> ConversationProjectionStore     atomic apply, does not reinterpret business events
  -> SessionPane                     renders by rows and explicit availability
```

Entry points:

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/event-normalizer.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `packages/ui/src/v4/conversationProjectionStore.ts`
- `packages/ui/src/v4/sessionDataLayer.ts`

## State owned by the projection

Region A of the snapshot carries explicitly: `control` (phase, stop state, active works, latest error and API retry); `availability` (fork, compact, model/mode switch, queue operations, goal operations); `inputRouting` (`startNow | enqueue | guide | reject | choice`); `meta`, `config`, `usage`; `queue`, `pendingInteractions`, `pendingCommands`, `backgroundWorks`; `goal`, `plan`; `rows` and window info.

The UI must not derive these from the message array, the last message, tool state or local task runtime. The renderer owns only draft, focus, scroll, layout and a temporary optimistic overlay keyed by `commandId`.

## The five deltas

The incremental set is closed:

```text
row.appended { row }
row.upserted { row }
row.removed  { fromRowId }
row.delta    { rowId, path, append }
state.updated { patch }
```

`state.updated` replaces keys wholesale (no deep merge); `row.removed` truncates from the given rowId. A structural change not unambiguously expressible by these five operations must trigger snapshot/resync; the client must not add patch algorithms.

Each user input, timeline marker or child-session fact keeps `sourceCommandId` where possible. It is the shared anchor for command dedup, `commands/query` after a lost ACK, and optimistic overlay closeout.

## Live and cold recovery

The CLI event log is a bounded in-process log, not a cross-restart persisted fact. In normal running the publisher advances the projection incrementally from live canonical events; on CLI restart or first cold subscription, `transcript-hydration.ts` synthesizes equivalent events from persisted message/part, timeline part, session input ledger and session metadata and feeds the same normalizer/projection.

The guarantee is therefore "the same persisted facts recover to the same product end state", not "any historical revision is retraceable". If the live log covers only part of the transcript, the gateway selects full hydration/merge by footprint check; rendering database messages on a UI side path is forbidden.

## Subscription and delivery boundary

- desktop uses `desktop-continuous`: keeps online streaming `row.delta`.
- mobile remote uses `web-remote-replayable`: relies on snapshot/gap recovery and may filter non-replayable intermediate deltas.
- The profile may change intermediate frames but never command, row terminal state or the final projection.
- Each connection/subscription maintains its own ownership, seq, logEpoch and recovery generation.
- Host, desktop main and relay neither store the projection nor build a second reducer.

## Long-session window

The schema defines rows window and old-range read semantics. Clients must follow the window the snapshot provides and must not assume every snapshot contains the full history. The UI's full `loadOlder` interaction for very long history is still to be added; until it lands this is an explicit limitation, not a reason for clients to scan legacy messages to fill in.
