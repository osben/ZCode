# Fork Session Title Design

## Problem (historical)

Fork child sessions showed as「新任务」in the task list instead of `Fork of <parent title>`. The fork child's persisted title (`session.title = "Fork of <parent title>"`, `title_source=generated` in `~/.zcode/cli/db/db.sqlite`) never reached the child's own v4 event/projection. The v4 sessions-index live summary derives from `ConversationSnapshot.meta.title`, and `ProductProjection` updates `meta.title` only on `SessionTitleUpdated`. After resume a fork child emits only `SessionResumed`, so the `v4/conversation/frame` sessions-index delta stayed `title: ""`, `titleSource: "default"`, and the UI fell back to `task.forkedFromTaskId ? taskList.forkedUntitled : taskList.untitled`. Live `getSessionIndexMeta` also returned only `createdAt` and `lastActivityAt`, without `parentSessionId`, so the fork relation could be lost from the live summary as well.

## Root cause

The persisted title was written only to the session store, not replayed into the child's v4 event stream.

```text
fork parent
  -> create child session in DB
       title = "Fork of <parent title>"
       parent_id = parent session
  -> create child runtime record
  -> child runtime resume
       before: SessionResumed only
       after : SessionTitleUpdated(generated) + SessionResumed
  -> child ProductProjection.meta.title
  -> sessions-index summary.title / parentSessionId
  -> UI task row/header
```

## Design

### Current naming rule (2026-11-12)

- When the CLI creates a fork, it applies a regex only to the parent title: a trailing `(number)` is incremented, and if there is none `(2)` is appended, with no space inserted. For example `Task -> Task(2) -> Task(3)` and `Task(9) -> Task(10)`.
- It does not query a database count or deduplicate. Repeated forks of the same parent all get the same title. Parentheses inside the body and non-numeric suffixes are kept as they are, an old `Fork of ...` title is just an ordinary parent title, and existing data is not migrated.
- `titleSource=generated`, auxiliary conversation titles and the existing title fact sync chain are unchanged.
- Acceptance: the CLI covers suffix parsing and repeated forks; the existing `conversation-session-fork-cold-start-membership.test.ts` covers the desktop first and consecutive forks, the cold-resume title, and the same-name result of repeated forks on mobile. SSH/WSL and Windows/Linux are not added to the required combinations for this change: naming runs in the same pure-string CLI path and has no platform or delivery-mode branch.

```text
parent title -> CLI regex builds child title -> session store -> sessions-index -> desktop/mobile
```

### Title fact sync

1. Sync the persisted title into the current runtime event stream on resume.
   - When `session.title` is non-empty, append `SessionTitleUpdated`.
   - `source` uses the persisted `session.titleSource`; `first_input` normalization still maps to `generated` in the v4 projection.
   - Only the current child runtime appends the event, so parent runtime events never land on the parent publisher.

2. Keep the fork parent relation in the bootstrap live record.
   - `ZCodeProtocolSessionRecord` gains optional `parentSessionId`; `createRecord` initializes it from `params.parentSessionId`.
   - Fork record creation passes `parentSessionId: fork.parentSessionId`; resuming an old session backfills from the session store's `parentID`.
   - The v4 bridge's `getSessionIndexMeta` passes the field through.

3. Test the live sessions-index, not only the DB.
   - Core resume regression: a fork child's persisted generated title must replay `SessionTitleUpdated` before `SessionResumed`.
   - v4 cold-resume integration: a fork child not present in the `roots: true` store seed must still expose `parentSessionId` in the live sessions-index summary.
   - Keep the existing core fork DB title tests.

## Non-goals

- No UI fallback copy changes; the fork naming logic does not move into the UI.
- desktop-continuous and web-remote-replayable recovery boundaries are unchanged; both consume the same v4 event/sessions-index facts.
