# Chat Message Queue (current state)

The single source of truth for the chat queue is the runtime command queue of each workspace CLI, projected to all clients through `ConversationSnapshot.queue`. The renderer keeps no accepted queue, and there are not two product orders (a desktop renderer queue and a mobile host queue).

## State chain

```text
desktop / mobile input
  -> V4 command admission
  -> inputRouting: startNow | enqueue | guide | choice
  -> CLI runtime queue
  -> ProductProjection.queue
  -> snapshot/delta
  -> queue UI
```

While running, both an ordinary `sendText` and `sendGoalCommand` are admitted by the CLI, which decides whether to enqueue. New input under a held queue must carry the user's disposition choice for the existing queue; the UI must not guess to clear or keep it.

## Operations

| User action      | V4 command         | Authoritative result                                                                                                                                         |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delete           | `deleteQueueItem`  | projection removes the queue item                                                                                                                            |
| Withdraw to edit | `deleteQueueItem`  | after projection removes it, the composer draft is restored on the initiating side only                                                                      |
| Send now         | `sendQueuedNow`    | CLI preempts the current turn (`preserveQueueAutoDrainOnCancel`, no queue hold written); the sent item runs first and the remaining queue continues in order |
| Reorder          | `reorderQueueItem` | projection returns the new order                                                                                                                             |
| Auto-drain       | `setAutoDrain`     | snapshot updates the auto-drain state                                                                                                                        |

Queue item commands (send now, delete, withdraw to edit, reorder) that hit `stale / proto.staleRevision` resend once using only the ACK's `revisionAtDecision`; if still unsuccessful, send-now and withdraw-to-edit show a retryable hint and the queue item keeps its original text (`specs/queue-command-stale-revision.md`, ISSUE-072).

The UI may give brief pending/disabled feedback on a click but must not only change a local array. On refresh, pane switch, or desktop and mobile online at the same time, the snapshot/delta is authoritative.

"Edit" in the first-party desktop, Web and mobile UI is not an in-place rewrite inside the queue; it withdraws the full input intent back to the composer that initiated the operation:

```text
click edit (queueItem, baseRevision, sessionId, workspaceKey)
  -> does the composer already hold text / attachment / web context / selection ref / uploading state
       |- yes: send no command, queue and existing draft unchanged, hint to deal with the current draft first
       `- no: lock the target queue row and the composer
              -> deleteQueueItem(baseRevision)
                   |- stale (proto.staleRevision)
                   |    -> stay locked, resend once with ack.revisionAtDecision (new commandId), then follow the branches below by the resend ACK
                   |- stale / noop / rejected / failed
                   |    -> do not restore the draft, unlock and hint to retry
                   `- accepted / duplicate
                        -> all clients receive the authoritative queue removal projection
                        -> only on the initiating side, and only if still the original session + workspaceKey,
                           restore kind + text + AttachmentRef[]
                        -> the user edits and resends, producing a new commandId / queueItemId
```

`workspaceKey = workspaceIdentity?.trim() || workspacePath`. The withdraw request is bound to the session and workspaceKey at click time; switching task/workspace before the ACK returns must not write the old payload into the new composer. A duplicate ACK or duplicate restore request must be idempotent. When the target was already consumed or deleted by another client, `deleteQueueItem` returns a distinguishable `noop` and must not restore an old projection as a local draft again.

Plain text and goal can be withdrawn; goal is restored as `/goal ...`. `compact` still has no edit entry. Attachments are restored as ready chips in their original queue order with the full `AttachmentRef`, marked as session-owned references; deleting, appending and resending directly do not upload/adopt again, and runtime restart and cleanup logic must not mistake them for staged refs not yet adopted. An image without a local object URL shows the file name and a type icon; no thumbnail download protocol is added.

The draft restored on the initiating side stays renderer-local and is not written into the conversation snapshot, relay or main process; other desktop or mobile clients consume only the authoritative queue removal. The underlying `editQueueItem` stays as a V4 compatibility capability but the first-party UI no longer calls it.

A `compact` queue item shows only the `/compact` command text, with no maintenance-command icon before it; it is still distinguished from ordinary messages by the "run now" button and its non-editable behavior.

"Send now" (Steer) and user "Stop" are two different interrupt semantics (ISSUE-039, see `specs/stop-queue-hold.md`):

- Stop is a user-initiated stop: it first writes `autoDrain=false` (held, `pauseReason=stopped`) and then aborts; the remaining queue stays paused and needs an explicit resume.
- Steer only preempts the current turn to run the selected queue item: no hold is written, `TurnComplete(cancelled)` carries `preserveQueueAutoDrainOnCancel`, and the projection keeps `autoDrain=true`; after the sent item runs, the remaining queue continues FIFO by auto-drain.
- A user Stop after Steer still writes a hold, same as a Stop alone.
- A user Stop always holds: a Stop arriving when the target was already interrupted (Steer, goal pause, etc.) but the turn has not closed yet keeps its own hold, and the remaining queue stays paused; the UI shows the generic paused copy (`specs/stop-queue-hold.md` rule 14).
- The preserve intent of Steer has two carriers: written on the execution when the runtime foreground token exists; written on the caller controller's abort reason when the runtime has no token yet (ISSUE-039 fix). A user Stop carries the intent in neither case.
- Edit and retry (`editUserQuery` / `retryTurn`) also interrupt a running turn but carry no preserve intent, so they hold the queue, same as a user Stop; this is current behavior, documented and not changed.
- The desktop continuous chain and the web/mobile remote replayable chain share the same CLI path; hold and resume are projection facts, and the snapshot after a reconnect must match the live state.

`guide` is the guidance semantic for the active turn and is not offered as an ordinary queue item with edit, delete or send-now. Stop stops only the current execution; whether the queue is held/resumes is stated explicitly by the CLI projection. Goal pause, resume and queue drain are also decided uniformly by the CLI reducer/handler.

## Current entries

- Schema: `packages/shared/src/zcode-protocol-v4/command.ts`, `snapshot.ts`
- CLI handlers: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`
- UI: `packages/ui/src/v4/SessionPane.tsx`
