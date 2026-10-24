# Goal Todo Summary Restore and Flicker Fix

## Problem

When a restored historical goal task continued with a new message, the summary panel could briefly show the current 5 todos as 20+ historical todos. The session store's current todo was still 5 after restore, but the snapshot merge after sending produced a local streaming assistant with `goalIteration=none`, and the plain todo summary flattened all `session` todoGroups into one list.

## State sources

- `session_target` is the authoritative persisted goal state.
- `todo` is the authoritative persisted short-term todo list of the session; `TodoWrite` replaces it as a whole.
- `todoGroups` is not independently persisted. It is projected at snapshot read time from history messages, the current todo, the current goal target and the verification timeline.

So the UI must not treat multiple `session` todoGroups as an accumulation of the "current todo list".

## Design

The summary panel's plain todo fallback shows only the latest `session` todoGroup:

- A live/runtime `plan` still wins.
- Without a `plan`, pick the latest `source: "session"` group from `todoGroups`.
- Do not `flatMap` all session groups, so historical TodoWrite results cannot bloat into an accumulated list when the goal target changes or is temporarily lost at a restore boundary.

Snapshot metadata backfill tolerates index misalignment caused by UI-only timeline messages:

- Current and snapshot messages at the same index with the same role keep the original backfill path.
- If the current list contains synthetic timeline or other UI-only messages, align by the visible order of non-timeline messages.
- Backfill still only adds display metadata and more complete snapshot fields; it does not change the replayable/continuous transport boundary.

## Boundaries

- No change to `todo` / `session_target` table structure; no new protocol field.
- Goal iteration grouping results are not persisted.
- Desktop `desktop-continuous` keeps direct streaming as the main path.
- Mobile `web-remote-replayable` still recovers via snapshot/gap semantics and does not bypass the replayable boundary.
