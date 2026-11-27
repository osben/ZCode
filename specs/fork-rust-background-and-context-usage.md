# zcode-rs: ended background commands and the authoritative context threshold

Two gaps in the Rust v4 projection against the Node CLI (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`).
Both were checked against the code before this spec.

## Part 1: ended background commands stay in `backgroundWorks`

### What Node does

`onBackgroundTaskLifecycle` (~5686) keeps a work after it ends. The runtime status maps to the summary status:

| runtime status                    | `backgroundWorks[].status` |
| --------------------------------- | -------------------------- |
| `running`                         | `running`                  |
| `completed`                       | `resultPending`            |
| `cancelled`                       | `cancelled`                |
| anything else (failed, timed_out) | `failed`                   |

An ended entry gets `endedAt` (the event time), `cancellable: false` (the runtime sends `status === "running" && ...`)
and `resultSummary` when the output tail is not empty: `(stderrTail || outputTail).slice(-4096)`.
Nothing touches the entry afterwards. The notification delivery (`applyBackgroundTaskNotification`, ~3003) only
settles the tool row. So `resultPending` is not a transient state: the entry stays until the Activity boundary folds it.
The comment in `packages/shared/src/zcode-protocol-v4/snapshot.ts` ("the entry disappears after delivery") does not match
the code. The UI follows the code: `ConversationStatusPanel.tsx` lists every non-running `bash` work that is not in
`activitySummaryDismissed.workIds`, shows `resultSummary` as the preview and counts `resultPending` as completed.

### What Rust did

`Projection::background_table` listed only the running commands, and the kernel ledger read
(`SessionHandle::background_tasks`, `session/src/tasks.rs` `running_on`) never returns an ended command: it skips every
entry that is not `Running`, and reads the output tail for running ones only. The TUI footer, `/tasks` and
`tasks_snapshot` rely on that, so the ledger read stays as it is. An ended command left the snapshot, and the capsule never
showed it.

### Rules

1. Owner: `Projection.shells` (`projection/background_shells.rs`). The ordered shell list holds running and ended
   commands in start order. An ended command keeps its slot.
2. A command that was `running` in the list and is no longer a running ledger entry has ended. The same holds for a
   ledger entry that reports a terminal status. The status comes from, in order: the kernel's `BackgroundWork` event or a
   notification text (`shells.ended`), then the ledger entry's own terminal status, then `failed` (Node's `lost`).
   The mapping is `completed` to `resultPending`, `killed` (and `stopped`) to `cancelled`, everything else to `failed`.
   A later `BackgroundWork` event corrects the status of an already ended work (the event and the ledger forgetting
   the command can arrive in either order); the item is not otherwise rewritten.
3. The item: `{workId, kind: "bash", title, status, startedAt (kept), endedAt (first observation, not rewritten),
cancellable: false, anchorRowId: null}` plus `resultSummary` only when the tail is not empty.
4. `resultSummary` is the tail of the command's output, read once when the end is first seen: `Live::shell_deltas`
   asks `SessionHandle::background_bash_output(id)` for each newly ended command (it still answers after the ledger
   acknowledged the notice) and hands the text to `background_table`. The text is cut to the last 4096 UTF-16 code
   units (zod `.max(4096)` counts JS `.length`; a longer value would fail the whole `state.updated` frame), on a character
   boundary. A failed or empty read leaves the summary out.
5. A command that runs again (same id back in the ledger as running) replaces its ended item and keeps `startedAt`.
   This covers a transient ledger read that listed nothing. The Activity release rule already removes an id from
   `workIds` when its work runs again.
6. Delivery: the list goes out as `state.updated {backgroundWorks}` in the frame of the change, and the snapshot carries it.
   An unchanged list is no patch.
7. Activity boundary (`specs/fork-rust-activity-summary.md`): `fork/activity_summary.rs::dismissed` already collects every
   work whose status is not `running`, so an ended command is in `workIds` after the next real user message and the UI
   folds it. An end event that came in the same batch as the real input counts even though the table refresh after the
   batch has not marked the work ended yet (`boundary_works_value`). A background result row does not set the boundary.

```text
BackgroundWork{work,status} ─► Projection.remember_ended ─┐
notification text ──────────► Projection.remember_notified ┤
ledger read (running only) ─► Live::shell_deltas           │
   vanished running ids ─► background_bash_output ─► tail ─┴─► background_table ─► state.updated {backgroundWorks}
real user row ─► Live: boundary.workIds = works with status != running
```

### Divergences from Node

- Node prefers `stderrTail` over the stdout tail. The Rust kernel keeps one merged output file, so the summary is the
  tail of that file.
- A Monitor ends with a status but no `resultSummary` (`background_bash_output` answers None for a Monitor).
- `Projection::rebuilt` (rewind, edit, retry) and a cold open start with no shell list, and there is no event replay, so
  ended commands are gone after those. Node rebuilds them from its events.
- A command that vanishes from the ledger before its notice reached the projection shows `failed` until the event arrives
  and corrects it.

## Part 2: `autoCompactThresholdAuthoritative`

Node sets `usage.contextWindow.autoCompactThresholdAuthoritative: true` whenever the runtime event carries
`autoCompactThresholdTokens`, a number or `null` (null is a disabled policy, `resolveExecutionContextBudgetThresholds`
with `compactConfig.enabled === false`). The UI ignores the threshold unless the flag is true
(`V4ComposerToolbar.tsx`, `contextUsage.tsx`), so without it the tooltip and warning tone use an estimate.

### Rule

The Rust kernel's `ContextOccupancy.compact_at` is the effective threshold the kernel itself acts on: `Some(n)` is a
threshold, `None` is auto-compact off or reactive-only (no proactive compaction). Every published context window is built
from a kernel occupancy (live `ContextUsage` event or the session view), so `state::usage` sets
`autoCompactThresholdAuthoritative: true` on every non-null `contextWindow`, including `autoCompactThresholdTokens: null`.
The one builder feeds both the snapshot and the `state.updated` patch. A null `contextWindow` (unknown model) carries
nothing.

### Divergences from Node

- Node nulls a numeric threshold on a model switch until the next main-turn completion. The Rust kernel re-emits
  `ContextUsage` with the new threshold at the switch, so Rust never shows a stale or placeholder value.
- Reactive-only compaction is `null` with the flag (auto-compact off for the UI), which reads the same as a disabled policy.
- A cold open sends the flag from the first snapshot (the kernel computes the occupancy at open); Node has it after the
  first completed turn (not verified for the cold seed path).

## Acceptance

- A running command, then the end by exit 0, non-zero exit, and kill: the entry stays with `resultPending`, `failed`,
  `cancelled`, `endedAt`, `cancellable: false`, and the output tail as `resultSummary` (cut to 4096 UTF-16 units; a
  non-BMP tail stays under the cap).
- An empty tail has no `resultSummary`. An ended entry keeps its slot and its `endedAt` across later reads.
- A real user message after the end puts the command in `activitySummaryDismissed.workIds`; a background result row does not.
- A context window with `compact_at: Some(n)` and with `None` both carry the flag, in the snapshot and in `state.updated`.

Coverage: `projection/background_shells_tests.rs`, `projection/projection_tests.rs`,
`server_completed_activity_tests.rs`.
