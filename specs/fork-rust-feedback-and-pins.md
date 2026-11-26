# zcode-rs: message feedback (`setAssistantFeedback`) and pins (`setRowPinned`)

The App shows thumbs up/down under the latest assistant text and a pin on assistant and typed user messages. On the Rust
runtime both commands answered `proto.unsupportedCommand`, and the projection never sent the row fields `feedback` and
`pinnedAt`, even for a session Node had written. Product rules: `docs/chat/assistant-latest-part-actions.md` and
`docs/chat-message-pins.md`.

## Node reference

- Handlers: `zcode-protocol-v4/commands/handlers/assistant-feedback.ts` and `row-pin.ts`.
- Persistence: `assistant-feedback-persistence.ts` and `row-pin-persistence.ts` (transcript first, then the event).
- Projection: `product-projection.ts` `onAssistantFeedbackUpdated` / `onRowPinnedUpdated`, and `transcript-hydration.ts`
  (cold replay of the stored metadata).
- Row schema: `packages/shared/src/zcode-protocol-v4/rows.ts` (`feedback` on `assistantText`, `pinnedAt` on
  `assistantText` and `userInput`).

## Durable facts (shared with Node, no migration)

The only durable fact is the `metadata` object of the stored message record (`message.data`):

| Fact                                                   | Written by             | Meaning                                  |
| ------------------------------------------------------ | ---------------------- | ---------------------------------------- |
| `metadata.assistantFeedback` = `"like"` or `"dislike"` | `setAssistantFeedback` | key deleted when the feedback is cleared |
| `metadata.pinnedAt` = epoch milliseconds (CLI clock)   | `setRowPinned`         | key deleted on unpin                     |

When a write leaves `metadata` empty the member is dropped, and a written `metadata` moves to the end of the record, as in
Node (`{...infoWithoutMetadata, metadata}`). Other `metadata` keys (`conversationInputIntent`, `epilogueStart`, ...) are
kept. The record is saved through the same path as every message save, so the legacy `model` member of a user record and
the `time_updated` rule do not change.

Node also appends a `assistant_feedback_updated` / `row_pinned_updated` session event. Node's session event store is in
memory (`createSessionEventStore` defaults to `createInMemorySessionEventStore`), nothing of it reaches the shared
database, and cold hydration rebuilds the same events from the metadata. The Rust counterpart of the event is the kernel
event `MessageMarked`, which the projection turns into a `row.upserted` delta. No event row is written.

## Owner and event order

1. Owner: the session actor (the single owner of commits). The `v4` handler sends one kernel command and never touches the
   store or the projection.
2. Order for one command: validate the message against the active history, commit the fact (the store edits the record),
   update the actor's mark map, append the `MessageMarked` kernel event, ack. A commit failure changes nothing (no map
   change, no event) and the command is rejected. Node's compensating restore is therefore not needed: one transaction
   either edits the record or does not.
3. The projection (`Live`) applies `MessageMarked` and emits `row.upserted` (plus the usual `state.updated` revision).
4. Rebuilds (rewind, edit, retry, resubscribe snapshot) read the actor's mark map through the session view, so a like or a
   pin survives them. A cold open reads the stored metadata into the same map (`LoadedSession`).

## Commands

Both are CAS commands (`baseRevision`, `baseLogEpoch`) and row-targeting, already in the inbound schema.

`setAssistantFeedback {target: {rowId, entityId}, feedback: "like" | "dislike" | null}`

`setRowPinned {target: {rowId, entityId}, pinned: boolean}`

Target resolution (Node `resolveRowActionTarget`, run by the gateway before the handler):

| Case                                                                                     | Ack                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| row not in the projection, or its `entityId` differs                                     | `stale`, `proto.staleTarget`                |
| feedback on a row that is not `assistantText`, or an `assistantText` row with no message | `rejected`, `guard.actionUnavailable`       |
| pin on a row that is not `assistantText` / `userInput`                                   | `rejected`, `guard.actionUnavailable`       |
| pin on an `assistantText` row that is not `complete`                                     | `rejected`, `guard.actionUnavailable`       |
| pin on a `userInput` row whose origin is not `realUser`                                  | `rejected`, `guard.actionUnavailable`       |
| the message is gone from the active history when the actor runs the command              | `rejected`, `proto.staleTarget`             |
| commit failure                                                                           | `rejected`, `fault.command.executionFailed` |

`fault.command.assistantFeedbackUnsupported` and `fault.command.rowPinUnsupported` are Node's answers for a host without
the method. Rust always has the method, so it never sends them. The wrong-row-kind refusal is `guard.actionUnavailable`,
the gateway's answer in Node, not those two codes.

The target needs no typed user row (unlike `editUserQuery`), so a reply in a turn opened by a notification can be liked.

## Row mapping

A Rust `assistantText` row has one row per text block of a message, with `entityId` = `<messageId>:<blockIndex>` and
`assistantResponseId` = the stored assistant message id. Node uses the message id as the shared `entityId`. The mapping
is therefore by `assistantResponseId`:

- feedback goes to the **last** `assistantText` row of the message (Node `findLast`: the UI reads the last row);
- the pin goes to the **first** row of the message (Node `find`);
- a `userInput` row with `origin` `realUser` is matched by `entityId` = the user message id.

Clearing removes the field from the row. A change that equals the row's value emits no delta.

Cold open and rebuild apply the stored marks right after the message's rows exist, with no state check (Node replays
the metadata after the row-creating event). The same row-level shape is used live and cold.

## Idempotency

- Pin when already pinned keeps the first `pinnedAt`; unpin when not pinned. Both write nothing, emit no event and are
  accepted.
- Feedback with the value already stored is accepted and writes nothing (see divergences).
- `pinnedAt` comes from the session's injected clock (`Date.now()` in Node).

## Divergences from Node

1. No event row (above): the kernel event is in memory only, as Node's default event store is.
2. Feedback equal to the stored value is a no-op in Rust. Node rewrites the same record and appends an event the
   projection then ignores. The durable state and the row are identical.
3. A pin targets the message id from `assistantResponseId`. A message whose rows were all streaming (no
   `assistantResponseId` yet) is refused with `guard.actionUnavailable`; Node knows the message id from the first frame
   but refuses an unfinished row too.
4. No compensating rewrite on a failed commit (single transaction).

## Tests

- `kernel-api`: mark types and the `Fact` / `KernelEvent` shapes.
- `node-store`: record edit (set, change, clear, drop empty `metadata`, other keys kept, user `model` member kept), load
  reads the stored marks, including the Node fixture `node-cold.json` (`a2` liked).
- `session`: command validates role and presence, pin idempotent, clock-stamped `pinnedAt`, event order, view carries the
  map (the rebuild source).
- `protocol-zcode`: cold load of a stored like and pin shows `feedback` / `pinnedAt`; set, change, clear; pin, unpin,
  repeated pin; wrong row kind and stale target refusals with Node's codes; the live delta (`row.upserted`) and the
  rebuild from the view; the inbound envelope reaches the handler.
