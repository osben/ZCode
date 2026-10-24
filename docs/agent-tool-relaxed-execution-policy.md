# Agent tool relaxed execution policy

## Background

Consecutive subagent failures trace first to two local policies, not to same-type `Agent` tool call rejection:

- `TodoWriteInputSchema` rejected multiple `in_progress` todos at the schema layer, failing `TodoWrite`.
- `executeToolSchedule` saw a prior non-`concurrentSafe` tool failure, emitted skipped results for later schedule groups, and stopped execution.

Both truncate the remaining tool calls the model produced in one batch, so these two local policies are relaxed.

## Behavior

- `TodoWrite` no longer hard-rejects multiple `in_progress` todos at the runtime schema layer; `summary.inProgress` counts the real number.
- `TodoWrite`'s provider-visible description stays as-is; it does not invite the model to write multiple `in_progress`.
- Tool scheduling executes groups in the existing `parallelGroups` order. A plain failure in one group no longer auto-skips later groups; whether later tools run is decided by their own permissions, cancellation signal, handler errors, and schedule grouping.
- `turnControl.stopTurnAfterResult` is an explicit turn boundary. When a tool result asks to stop the current turn, later schedule groups skip real handlers and emit cancelled results to close the provider-visible tool call history.

## Non-goals

- No change to todo storage structure; no id-based task store.
- No UI/TUI summary display change; if the UI highlights one `in_progress`, that display semantics stays.
- Old validation and skip branches remain as comments for comparison or rollback.

## Acceptance

- A `TodoWrite` with multiple `in_progress` writes and reads back successfully.
- In plan mode, after a prior write tool is permission-denied, later read-only tools still run and return real results to the model.
