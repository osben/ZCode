# Queue commands rejected for a stale revision (ISSUE-072)

## Problem

Queue commands carry a session-wide CAS: `sendQueuedNow`, `deleteQueueItem` and `reorderQueueItem` are in
`COMMANDS_REQUIRING_BASE_REVISION` (`packages/shared/src/zcode-protocol-v4/command.ts`), and the CLI
`CommandInbox.decide` returns `stale / proto.staleRevision` whenever `envelope.baseRevision` differs from the
publisher's current revision (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`).

The revision moves on every structural delta: row appended/upserted/removed and any `state.updated` that touches
`control`, `availability`, `queue`, `backgroundWorks`, `subagents`, ... (`projection-state.ts`
`REVISION_BEARING_PATCH_KEYS`). The renderer reads the revision from `snapshotRef.current`, which is only assigned
on render. A queue command sent while a previous queue mutation (delete, re-add, edit) or a running turn has a delta
in flight therefore carries a revision the CLI has already passed.

Before this fix the renderer only logged the stale ACK (`sendQueuedNow 被拒绝: stale proto.staleRevision`): Steer
silently did nothing and the item waited for the running turn; Edit showed a transient toast and left the item queued.

## Owners and event order

- Revision owner: the CLI conversation publisher (`ProductProjection.attachRevision`). The renderer never derives
  or advances it.
- Admission owner: CLI `CommandInbox` (serial per session). The renderer keeps only drafts and the optimistic overlay.
- Item validation owner: the CLI queue handlers (`commands/handlers/queue.ts`): a missing item is `noop`
  (`queue.itemMissing`) or `rejected`, a reserved item is `guard.queueItemReserved`.

```text
Renderer (snapshot rev N)        Host (forward only)          CLI CommandInbox / publisher
  delete B  ── deleteQueueItem(N) ───────────────────────────▶ accepted, queue delta → rev N+1
  ◀──────────────────────────── ACK accepted ─────────────────
  click Steer A (snapshotRef still N; delta N+1 not rendered yet)
            ── sendQueuedNow(N) ────────────────────────────▶ N ≠ N+1 → stale, revisionAtDecision=N+1
  ◀────────────────────────── ACK stale(N+1) ─────────────────
  retry once ── sendQueuedNow(N+1), new commandId ──────────▶ queue handler validates queueItemId
  ◀────────────────────────── ACK accepted | noop | rejected ─
  delta rev N+1 (and later) arrives through the normal stream; the UI follows the projection
```

## Rules

1. Queue item commands (`sendQueuedNow`, `deleteQueueItem` for Delete and for Edit, `reorderQueueItem`) whose ACK is
   `stale` with `proto.staleRevision` are re-sent exactly once with `baseRevision = ack.revisionAtDecision` and a
   new `commandId`. The intent is item-scoped (`queueItemId`), and the CLI handler re-validates the item, so a newer
   session revision does not change what the user asked for. This matches the config CAS precedent
   (`dispatchConfigCas`).
2. Only `proto.staleRevision` is retried. `proto.staleLogEpoch` / `proto.staleTarget`, `rejected`, `failed` are not.
3. At most one retry per user action; no timers, no waiting for the projection to catch up.
4. `noop` after the retry (the item drained or was removed elsewhere) is silent: the projection already shows it.
5. Steer: when the final ACK is not `accepted`, `duplicate` or `noop`, show `chat.queue.sendNowFailed`, except
   when Steer lost the race to the auto-drain or the turn end: `guard.queueItemReserved` (the drain already
   reserved the item), `sendQueuedNowRequiresRunning`, or the item is no longer in the latest projection. Those
   stay log-only because the item is already running or drains next. `guard.queuePromotionBusy` (another
   promotion holds the lease) does show the toast: the item was not sent and Steer can be retried. The item
   stays queued, so the user can press Steer again. The Highspeed refresh computed for the first attempt is reused
   for the retry; it is not prepared twice.
6. Edit: the queue row and composer lock (`queueEditOperation`) stays held across the retry. The composer is
   restored only for a final `accepted` / `duplicate`. Any other final status keeps the item queued with its text
   (nothing is lost), clears the lock and shows `chat.queue.editRestoreFailed`.
7. Delete and reorder keep their log-only failure handling after the retry (the row stays visible, which is the
   feedback).
8. `setAutoDrain` (Resume) is a toggle, not an item command, and is not covered here (follow-up).

## Acceptance

- Unit (`packages/ui/test/v4QueueCommandStaleRetry.test.ts` (helper) and `packages/ui/test/v4SessionPaneEditUserQuery.test.ts` (SessionPane, "ISSUE-072" describe)):
  - Steer: stale(revisionAtDecision 9) then accepted → two dispatches, `baseRevision` 7 then 9, no toast.
  - Steer: stale twice → exactly two dispatches, then the `sendNowFailed` toast.
  - Steer: `failed / guard.queueItemReserved` → one dispatch, no toast.
  - Edit: stale then accepted → composer restore request with the queued text.
  - Edit: stale twice → no restore, lock cleared, `editRestoreFailed` toast.
  - Delete: stale then accepted → second dispatch with the new revision.
  - Helper: `proto.staleLogEpoch` / `proto.staleTarget`, `rejected`, `noop`, `failed` are not retried.
- E2E (desktop, not run in the fix session; covered by the QA verify steps): CP-13 steps 1–5 with quick queue
  edits right before Steer and Edit, three times each. Steer starts A at once; Edit returns the text to the
  composer; no `被拒绝: stale` warn without a follow-up retry; both desktop-continuous and web-remote-replayable
  share this renderer path.
