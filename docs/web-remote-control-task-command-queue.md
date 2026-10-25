# V4 cross-client authoritative input queue

## Conclusion

The old "desktop renderer-local queue + mobile host runtime command queue" dual-queue semantics have
left V4. All submitted busy/running input from desktop and mobile goes directly into the same CLI/runtime
`CommandInbox`, and FIFO order follows the CLI serialized admission order. The host's owner/lease only
routes and no longer owns a second accepted-input queue.

```text
Desktop continuous command ─┐
                            ├─> owner route -> CLI serialized admission -> one FIFO
Mobile replayable command ──┘                                      |
                                                                    ├─ queue
                                                                    ├─ guided row
                                                                    ├─ transcript
                                                                    └─ rejected/failed/discarded
```

Final invariant: before the UI clears a submitted payload, the authoritative layer must already have
recorded its single destination; there must be no case where "the UI cleared it but the CLI has no
queue/guided row/transcript/explicit terminal result".

## Connection and routing boundary

- Desktop (including SSH/WSL/Docker windows) is trust-marked by the host as `desktop-continuous`.
- Mobile `/remote` / Web remote is trust-marked as `web-remote-replayable`.
- `clientMode` is injected by the attachment and cannot be forged by a UI command.
- Mobile V4 bypasses the host runtime command queue of `IZCodeTaskService.enqueueTaskCommand`.
- Remote workspace, bot/proxy or cross-host fallback still routes the command to the right CLI through owner/lease/stale-run.
- The remote chain carries `workspaceIdentity` and `remoteSessionId` throughout; the identity key cannot be `workspacePath` alone.
- Each desktop window has exactly one Window Host and one realtime `hostId`; local/remote commands are
  routed inside the Host by `workspaceKey + taskId`, and `remoteSessionId` only selects the source within
  the window and cannot replace workspace identity.

## ConversationInputIntent

Each admitted input is self-contained and conserved across all fields through queue/runtime/transcript:

- The original `sourceCommandId` and a stable `queueItemId`.
- `clientId`, kind, original text, attachments.
- delivery requested/admitted and fallback reason.
- CLI admission order and queue position.
- steer and dispatch state.

The QueueItem, drain/guided event, user row and message anchor use the same original `sourceCommandId`.
promotion, edit or send-now cannot replace it with the id of the operating command.

On persistence, both the message metadata and the session-input ledger write the full
`conversationInputIntent`; the message anchor additionally writes the same `sourceCommandId` for the dedupe
index. The old `metadata.inputIntent` is read for compatibility only and is not the authoritative format for new writes.

When guide is not applicable, there are attachments, compact/verifier is busy, or the runtime steer rejects,
the full intent falls back to the ordinary queue. An empty, over-limit or runtime-rejected input returns an
explicit `rejected/failed`, and the UI keeps the text and attachments.

## Queue operations

`editQueueItem` updates in place, keeping the item ID, source command, original position, attachments, client
and admission order; only the new fields the user explicitly submitted change. reorder/delete also modify the
same authoritative queue through CLI commands.

`sendQueuedNow` does not delete first and send after:

```text
reserve(item)
  -> stop barrier
  -> start/promote(item)
  -> remove(item) only after start succeeds

timeout/failure -> release reservation -> the original item keeps its position and fields
```

Consecutive clicks on the same item or multi-client races have only one reservation owner. The reservation
lives in the shared CLI runtime; `reserved/promoting` is projected through the event stream to all
desktop/mobile subscribers and pauses ordinary drain. Promotion reads the full QueueItem and keeps the
original `sourceCommandId` and attachments; remove with the same reservationId happens only after start
succeeds. That remove uses the `promoted` reason, only takes the item off the queue, and does not mark the
durable ledger cancelled; after the user message commits atomically, `SessionInputPromoted` unpins it, and a
crash before commit recovers it as explicit discarded.

## ACK, query and UI reconciliation

The UI keeps a 24-hour pending-command registry: ordinary text/goal store a resendable payload; sensitive
interactions store only a digest. Once a QueueItem/guided projection appears it proves the authoritative layer
has received it, and the corresponding registry record is deleted at once; this registry is not a second
cross-runtime queue.

When an ACK is lost or on reconnect, `commands/query` is called with at most 64 `{sessionId, commandId}` per
call. The CLI query order is fixed:

```text
memory LRU
  -> transcript/message anchor sourceCommandId
  -> timeline marker sourceCommandId
  -> fork child metadata sourceCommandId
  -> discarded input ledger
  -> unknown
```

Queries and executions with the same key are single-flight; a query must not return `unknown` in the window
where execution has started but the result is not written back yet, which would induce duplicate side effects.
sendText/sendGoal/createSession.firstInput save the full `conversationInputIntent` and pin it before the
handler; the promotion event first invalidates the old transcript query seed and then unpins, so even if 512
ACK churn follows, the origin lookup can only see the transcript or explicit discarded and cannot degrade to unknown.

## Recovery and process boundary

The queue is reliable only within the current CLI process; it covers UI rebuild, mobile network drops and
attachment reconnect, but promises no continued execution after a CLI restart. On CLI restart, admitted input
that has not entered the transcript/explicit terminal state is written to the discarded ledger;
`commands/query` returns the failure reason `fault.command.inputDiscardedOnRestart` and the persisted `delivery`.

If the task has not been resumed, the first `commands/query` also closes out the admitted ledger left by the
previous CLI process as discarded, so there is no "unknown first, discarded only after subscription" race.
Successful side effects without a user message, such as timeline/child, write `v4/command_fact`, and a query
after restart still returns the original ACK/result.

`queue/guide` belongs to the old runtime and the client clears the account silently; only a `startNow` that
has not entered the transcript, or `unknown`, shows a "confirm resend" entry (zh-CN "确认重发"), and nothing is
ever replayed automatically. An ordinary mobile disconnect is still recovered from the current runtime's
replayable snapshot of the authoritative queue; the relay, desktop main and host cannot bypass this product
boundary through a private persistent queue.

### 2026-09 virtual project directory navigation

The mobile home reuses ProjectSidebar and reads the Host's project row set through the current base attachment;
the mobile shell owns only home/chat and browser back state. `workspace-bridge-open.project` is a strict
projectId/hostId intent that main hands to the window Host's ProjectService to prepare the execution directory.
It may create or reuse a directory logical scope on an already-online physical Source, and must not implicitly
create a physical connection, Host or Agent. Before and after preparation it checks the member identity, project
entry and physical connection object; main keeps only the RPC promise of the current navigation, a retry with
the same bridge identity does not allocate a directory twice, and cancel/window close/later navigation
invalidates a late result.

The Host returns the trusted workspaceIdentity, remoteSessionId and cwd, and the mobile replayable bridge is
established along the original shared-host attachment. Project/provider/initial input are passed only in the
Web Root handoff, and main stores no draft or task business state. Desktop direct continuous, mobile
snapshot/gap recovery, owner/lease and the CLI CommandInbox single-queue rule are unchanged.
