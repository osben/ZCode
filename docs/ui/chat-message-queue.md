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

| User action | V4 command                                                      | Authoritative result                                                                                                                                         |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delete      | `deleteQueueItem`                                               | projection removes the queue item                                                                                                                            |
| Edit        | `lockQueueItemEdit` -> `editQueueItem` / `releaseQueueItemEdit` | the item stays frozen in place while editing; submit replaces it in place and unlocks, cancel unlocks                                                        |
| Send now    | `sendQueuedNow`                                                 | CLI preempts the current turn (`preserveQueueAutoDrainOnCancel`, no queue hold written); the sent item runs first and the remaining queue continues in order |
| Reorder     | `reorderQueueItem`                                              | projection returns the new order                                                                                                                             |
| Auto-drain  | `setAutoDrain`                                                  | snapshot updates the auto-drain state                                                                                                                        |

Queue item commands (send now, delete, reorder) that hit `stale / proto.staleRevision` resend once using only the ACK's `revisionAtDecision`; if still unsuccessful, send-now shows a retryable hint and the queue item keeps its original text (`specs/queue-command-stale-revision.md`, ISSUE-072).

The UI may give brief pending/disabled feedback on a click but must not only change a local array. On refresh, pane switch, or desktop and mobile online at the same time, the snapshot/delta is authoritative.

"Edit" in the first-party desktop, Web and mobile UI reuses the bottom composer; the queue item stays in place and is frozen by the CLI while editing. Full interaction, draft stash, invalidation and lock release: [Composer edit mode](composer-edit-mode.md).

```text
click edit (queueItem, sessionId, workspaceKey)
  -> composer busy (uploading / sending)? yes: send no command, hint to retry later
  -> lockQueueItemEdit(queueItemId, editorId), target row shows pending
       |- reserved / already locked / noop / failed -> do not enter edit mode, hint the reason
       `- accepted (and still the original session + workspaceKey)
            -> stash the current draft; composer loads the original kind + text + AttachmentRef[] + model/mode/Plan config
                 |- cancel -> releaseQueueItemEdit -> restore the stash
                 |- send -> editQueueItem(content, attachments, config, editorId) replaces in place and unlocks -> restore the stash
                 `- item deleted / released by another client -> invalid, send as an ordinary new message
```

A frozen item keeps `queueItemId`, `sourceCommandId`, position and kind. Auto-drain pauses when it reaches the frozen item and later items keep waiting in order; a frozen item cannot be deleted, reordered or sent now, and other items are unaffected. The lock lives only in CLI memory and is never released by timeout.

`workspaceKey = workspaceIdentity?.trim() || workspacePath`. Edit mode is bound to the session and workspaceKey at click time; switching task/workspace before the ACK returns must not write the old payload into the new composer and immediately calls `releaseQueueItemEdit`.

Plain text and goal can be edited; goal shows as `/goal ...` and keeps its kind on submit. `compact` still has no edit entry. Attachments show as ready session-owned chips in their original queue order with the full `AttachmentRef`, are not uploaded/adopted again on submit, and attachments can be appended during editing as in a normal send. The model, reasoning, mode and Plan recorded on the item load into the toolbar and are written back in place with `editQueueItem` after the user changes them. An image without a local object URL shows the file name and a type icon; no thumbnail download protocol is added.

With a single queue item, the target row keeps the same DOM from click to edit mode: first a pending "locking" state, then, once the lock is accepted, directly the "editing below" placeholder. It must not fall back to a normal row (brightening again or exposing action buttons), does not revert after the placeholder appears, and is not removed while editing. The lock ACK and the `editLock` projection are not ordered: if the ACK arrives first, the initiating side shows its own placeholder from local edit state and the projection confirms later; no timers or fixed waits. The composer loads the body once, only after the lock is accepted, and the height change after loading happens once. Short text, multi-line text and attachments follow the same order. The E2E (B09g) starts DOM/per-frame sampling before the single click and verifies that the desktop draft is unchanged when a phone starts the edit.

Edit mode and the stash stay renderer-local and are not written into the conversation snapshot, relay or main process; other desktop or mobile clients see only the authoritative `editLock` and can release it manually ("Release").

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
