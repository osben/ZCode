# Plan Independent Execution State (Todo151)

This spec supersedes the old Plan documents' mode=plan / prePlanMode implementation description; it
does not change existing model prompt text.

## Ownership and behavior

The Composer stores `{mode: build|edit|yolo, planEnabled: boolean}` for the next submission. The
menu lists Plan pinned on top, a divider, then the three permissions; Plan is selected
independently and never changes permissions. The Plan marker sits right of the permissions; its ✕
edits only the draft. The Plan menu item keeps the description "编辑前先出计划。" and its English
translation, using the same two-line layout as permission items. After the staging merge it keeps
using the effective shortcut table for permission-switch hints — no return to the old mixed
Plan/permission cycling.

Submit, Guide and turn end do not clear the marker; only approval being processed closes it
targeted. Rejection/feedback does not modify the draft. A tool-initiated EnterPlanMode turns the
marker on targeted; an approved tool exit closes it targeted. Simplified ruling (2026-09-15): when
a new tool result arrives, set the marker directly, even if the user changed the selection
meanwhile; each result is processed once. No ignore-list or draft-modification versioning, no new
visible history events, no restoring hidden EnterPlanMode rows.

```text
approve old plan -> user re-selects Plan -> approval result arrives -> clear Plan marker
                                                        -> replay of the same result does not clear again
```

```text
draft -> command admission freezes both values -> Runtime consumes -> unified state transition -> save and sync
               |                    ^
               +-> Queue round-trips the original values --+
Enter/ExitPlanMode -----------------+

desktop continuous: apply directly with live sync
mobile replayable: existing snapshot/gap recovery -> same Runtime, no new owner
```

Plan outranks yolo for tool gating; ExitPlanMode always needs approval. Approval only turns Plan
off and continues the current Turn — no permission change, no new user message. Rejection stops
the current Turn; feedback continues planning via the existing user-message path. Goal and Plan
are mutually exclusive. Guides that pin the execution model keep the model but still consume the
explicit permission and Plan. The existing planning/exit reminders only change their trigger basis
— not the prompt text, MCS, or output-style freeze mechanism.

## Compatibility and storage

- New `session_entry` type `runtime/execution_state` storing mode and planEnabled together in data;
  no new tables or columns.
- Written only on normal creation/state updates; no backfill scan of old records. Old
  `session.permission` and history messages are unchanged.
- New assistant messages carry `planEnabled` on normal save, for historical permission-boundary
  recovery by existing stable forks; the fork entry saves atomically with the child. Old messages
  are not backfilled and keep their original mode interpretation.
- New-session records outrank environment defaults; old sessions without a record read the
  compatible format; an old plan with no reliable base permission becomes build.
- Explicit `planEnabled` (false counts) wins; an old request with only mode=plan turns Plan on, one
  with only a non-Plan mode turns it off by old semantics; with neither, the current value is
  frozen at the admission boundary. The queue must never guess at consumption time.
- Old messages, tool results, the task index and automation configs stay readable with the old
  enums. Draft and Recent are independently compatible: an old Plan draft in an original session
  keeps its intent; a different new task does not inherit Plan.
- The new version guarantees cold recovery of the saved state. Rollback guarantees readable
  content but does not claim old binaries accurately restore the added Plan state.
- The Host declares support via the existing optional hello capability `independentPlanState`.
  Unsupported Hosts reject only new Plan=true submissions, preventing the field being stripped into
  yolo execution; normal sends, history reads and existing wire versions are unchanged.
- The Host must also confirm the actual CLI via `runtime/capabilities`, caching success per CLI
  client; a new Host with an old CLI likewise rejects Plan=true — Host version is never treated as
  remote capability.
- Permission and Plan persistence failures must not report the state as successfully synced; old
  data missing fields must not block opening history content.

## Must test

Queue real-event projection and promotion round-trip; in-place edit/reorder/Guide rollback;
yolo+Plan=false executing correctly, yolo+Plan=true still restricted and approved;
Enter/Exit tools' types, schema, permissions, returns and feedback; cold recovery, old-field
compatibility, fork recovery; new tasks default off; races between approval and manual ✕; desktop
vs mobile replay isolation.
