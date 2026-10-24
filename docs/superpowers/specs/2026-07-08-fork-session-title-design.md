# Fork Session Title Design

## Problem

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

- No UI fallback copy changes; the `Fork of ...` logic does not move into the UI.
- desktop-continuous and web-remote-replayable recovery boundaries are unchanged; both consume the same v4 event/sessions-index facts.
