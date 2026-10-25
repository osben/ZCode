# Draft first submit: task list and detail commit together

> First-submission lifecycle update (2026-10-20):
> [`specs/first-submission-lifecycle.md`](../specs/first-submission-lifecycle.md)
> now permits an immediate pending conversation before any Host row exists. The
> sidebar still uses only real Host rows; real session binding retains the atomic
> tree/navigation contract below. Submitted reserved sessions survive preparation
> failure. Historical validation records are not evidence for the new UX.

## Behavior and reason

User ruling (2026-09-15): when a draft is sent and the success spinner ends, the left side already has
and selects the task, and the right side enters the same task detail. The existing first-submission
lifecycle is reused; no protocol ACK field, task state or timeout compensation is added.

Measured: first-submission accepted had returned while initialization and the SessionStart hook were
still running. The first-input title event fired before the deferred promotion and was filtered by the
CLI list publisher; the later summary was already persisted but the runtime phase could still be draft
and was filtered by the Host. The old sidebar also started a full-tree read on every activity frame and
discarded the in-flight result, amplifying the latency.

## Owners and order

```text
CommandInbox accepts input → existing deferred promotion → publishCurrentSummaryToIndex
                                                ↓
                         task-facts ingest → tasks-index commit → task_created
                                                ↓
                  ProjectDirectoryProvider accepts a readTree containing the real row
                                                ↓
               same UI commit: update directory + handleDraftSessionCreated
                                                ↓
                       first-submit Promise completes, composer ends pending
```

1. CLI persistence decides whether it is an uncommitted draft; the runtime phase expresses execution
   state only. An uncommitted warm-up is not published to sessions-index; a committed summary that has
   not reached TurnStarted may land in the Host index.
2. task-facts remains the CLI fact ingestion entry, and the project Host still owns projectId/pin/archive.
   After the first summary is stored, task_created is published directly, without reading the complete
   session or waiting for the model/Hook just to back-fill a row.
3. The shared directory still accepts only real rows from the Host readTree. The first-submit callback
   waits for a full workspaceKey + taskId match, and the directory and the original navigation update in
   the same React commit; no optimistic project row is constructed.
4. Directory refresh merges overlapping requests; an invalidation notice received while in flight adds
   only one more read. The current read may commit and is not starved by continuous activity; a result
   after switching service/attachment or unmounting is invalid.
5. The accepted callback is only the work the UI completes in flight, not a second input queue. A read
   failure is reported to the caller, and leaving the original pane cancels navigation; neither may
   automatically resend the accepted input. Duplicate notifications do not navigate or create tasks twice.
6. Desktop continuous and mobile replayable share this UI/fact chain; the original owner/lease,
   CommandInbox dedupe and replay gap/snapshot recovery are kept, and main/relay and the runtime
   creation path are unchanged. Remote matching uses workspaceIdentity and carries the original remoteSessionId.
7. No database migration. Existing task send, fork, history open, project ownership and sort policy are unchanged.

## Acceptance

| Case  | Scenario/action                                                                                     | Must assert                                                                                                                                                     | Layer          |
| ----- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| FSV01 | First submit of a warmed-up draft, initialization has not produced the next event                   | The promoted summary is published before accepted; an uncommitted draft still does not enter the list                                                           | CLI unit test  |
| FSV02 | Receive a persisted summary with phase=draft                                                        | A real task row + task_created; zero readSession/resumeSession; a duplicate summary does not re-broadcast creation                                              | Host unit test |
| FSV03 | A directory read is in flight when the first submit completes, with continuous invalidation notices | No concurrent stacking, no starvation; the directory contains the row and the detail binding commit together; same cwd with different identity does not match   | UI unit test   |
| FSV04 | service switch/unmount, directory error                                                             | A stale response does not navigate, the error is observable, input is not resubmitted                                                                           | UI unit test   |
| FSV05 | Real desktop sends a draft                                                                          | Per-frame sampling: the first detail frame already has the sidebar row selected; the corresponding facts exist in CLI/Host; no task row before the first submit | pending E2E    |

Text and attachments share the first-submit callback and keep their original prewarm and
createSession(firstInput) paths respectively. Mobile is covered by shared-component and identity unit
tests for the wiring; real-device regression results are recorded separately.

## Verification record (2026-09-15, summary)

CLI sessions-index, Host syncer, UI first-submit/identity/cancel/service-generation, directory refresh
and stabilization, and composer continuity unit tests passed; a desktop replay of global and in-project
first submits (2/2) showed the first detail frame with one new selected visible row and zero new rows in
earlier draft frames. `pnpm typecheck`, `pnpm lint` (0 errors), desktop `typecheck:e2e`, bootstrap
`typecheck` and this case's `e2e:fixture:check` passed. Not run: mobile, Windows, Linux real-device
regression (no interface or transport semantics changed there). Known pre-existing gaps: an
unmanaged-new-file architecture gate item for `root/resolveConversationWorkspaceTarget.ts`, 19
max-lines errors in bootstrap scoped lint, one failing gateway case (Core admission ACK followed by an
old revision retry/file rewind expecting stale, got executionFailed; also failing without this fix), and
the full case coverage audit blocked by pre-existing metadata/stat issues; this case is not
auto-promoted to formal. The codegraph query failed (missing unresolved_refs table), so the impact
surface was traced from source.
Full history: `git show 37b98ff8:docs/task-first-submit-visibility.md`.
