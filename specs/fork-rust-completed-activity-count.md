# zcode-rs: Activity success total (`completedActivityCount`)

Upstream 4.0.0 added `completedActivityCount` to the v4 snapshot and `state.updated` patch
(`packages/shared/src/zcode-protocol-v4/snapshot.ts`, `delta.ts`): an optional non-negative integer or null. Node keeps
it in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`; the product rules are in
`docs/ui/chat-summary-panel.md` and `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` ("Activity 成功总数").
The UI (`packages/ui/src/v4/ConversationStatusPanel.tsx`) trusts the number over its own preview count, adds the
current turn's Bash successes itself, and shows no number when it is null. zcode-rs did not send the field, so the UI
fell back to the preview count, which stops at the 100-subagent / 8-run previews. The sibling field
`activitySummaryDismissed` is in `specs/fork-rust-activity-summary.md`.

## What is counted

The number of standalone subagents whose latest ended status is `success`, plus workflow runs whose latest status is
`completed`, across the whole session history. Bash is not counted. A workflow actor session is never counted as a
standalone subagent. Each child and each run counts once, by its latest state: a repeated or replayed fact never adds
up, and a resume of the same id takes it out of the count until it succeeds again.

## Owner and sources

1. Owner: the session's `Live` state (`packages/rust-cli/crates/protocol-zcode/src/live.rs`). The keyed outcomes and
   the derived count live in `fork/completed_activity.rs` (pure, no IO).
2. Full-history seed, read in the session's pump task so no live change interleaves with it:
   - runs and actor sessions: `DynamicWorkflowRunPort::activity_history` (Node `getActivityHistory`), the whole
     `dwf_run` / `dwf_actor` index of the parent session with each run's last event sequence
     (`node-store` `dwf::activity_history`), with no list limit;
   - child outcomes: `fork::subagents::ended_outcomes`, the same active-branch classification `session/subagents`
     pages through (store parts and child rows plus the kernel's live subagent table), with no page limit.
     A host with no run service has no runs, and a new session whose row is not written yet has no children (the
     seed still succeeds, so the total is 0). Any other failed read makes the count unknown (null).
     The seed is queued in the pump after the subagent table subscription, so a table change during the open runs
     after it.
3. Live updates:
   - the kernel's subagent table (`subagents_changed`): a running entry removes the child's outcome, an ended entry
     sets it (`Completed` = success, `Failed` = failed, `Killed` = cancelled);
   - run deltas (`workflow_runs_changed`): each run in the folded state sets its status at its `lastEventSequence`,
     and its actors' sessions join the workflow-child set. A fact older than the known sequence is ignored, so a seed
     read before a newer live delta cannot undo it. A run that leaves the bounded preview keeps its last known outcome.
4. Re-seed: every session rebuild (rewind, rewritten history) reads the full seed again. Child outcomes are replaced
   by the seed, runs merge by sequence, workflow children only grow. A rebuild's seed leaves out the kernel table
   entries that no tool part of the active branch links (children whose launch the rewind cut, even when they ended in
   this process) and records each id with the entry's execution number as cut. A cut id is ignored by later table
   changes, running or ended, until the table lists it with a newer execution (a resume of that child), which lifts
   the cut. A cut child that is still running and finishes later does not count. The open's first seed has no cut ids: a child whose
   link fact has not landed yet still counts. A rebuild that reads a child between its spawn and its link fact cuts it
   by mistake until it runs again; the window is a few milliseconds. A nested child (its entry has an owner) stays
   while its owner chain in the table reaches a launch the active branch links, because its own launch is stored in
   its owner's session.
   A child resumed by `SendMessage` after its launch was cut is linked by the resume: the store's subagent rows also
   return the `SendMessage` tool parts of the active branch (`parent_rows`, a read of the same tool-part rows, no schema
   change), and a completed one whose `input.to` is the table entry's agent id keeps that entry. Node links the resumed
   row to the `SendMessage` call the same way (its spawn event carries that call). Only the cut test reads these
   parts; the subagent directory still lists children by their `Agent`, `Task` and `subagent` parts only, as Node's
   `candidateFromToolPart` does, so a resumed child whose launch is cut is counted but not listed.

## Delivery

- Snapshot: always carries `completedActivityCount`. A new empty session starts at `0`. A cold open of a session
  with stored messages starts at `null` until the seed lands (Node's history-first first frame).
- `state.updated {completedActivityCount}` goes out in the same frame as the change that moved it, only when the
  value differs from the last one sent. The desktop `desktop-continuous` stream and the mobile `web-remote-replayable`
  replay read the same field.
- No timer, retry or UI cache. A failed seed stays null until the next seed (the next rebuild or open).

```text
open / rebuild ──► pump: seed (journal index + ended_outcomes) ──┐
subagent table ──► pump: subagents_changed ──► child outcome ────┤
run deltas ──────► pump: workflow_runs_changed ──► run outcome ──┼─► CompletedActivity.count()
                                                                 │
                         Live.collect: count != last sent? ──────┴─► state.updated + snapshot
```

## Divergences from Node

- Node's live child outcomes come from subagent spawn/stop events and transcript row removal; zcode-rs persists no
  spawn events, so live outcomes come from the kernel's subagent table and a rewind re-reads the store instead of
  revoking ids by removed message.
- Node updates the count incrementally inside its projection transaction; zcode-rs derives it from the keyed maps on
  each change (a few hundred entries at most). There is no rejected-candidate rollback in zcode-rs.
- Rewind: Node revokes the children whose launch rows the rewind removed. zcode-rs does the same by comparing the
  kernel's subagent table with the active branch (rule 4): an entry of the table that no tool part of the rewritten
  branch links is cut and does not count, and the table does not bring it back until a newer execution of it appears.

## Acceptance

- 9 completed runs, then failed and stopped ones: still 9.
- 105 successful children, more than the 100-item preview: 105.
- A resumed run or child leaves the count until it succeeds again.
- A child that succeeded in this process and whose launch a rewind cut: not counted after the rewind, and a repeated
  table read does not bring it back.
- The same event replayed: no change.
- A workflow actor session that succeeded is not counted on top of its run.
- An unreadable journal or store: null, never a partial number.
- A new session opened before its first message is saved: 0, then live updates.
- A cold open with history: null in the first snapshot, then the seeded number.

Coverage: `packages/rust-cli/crates/protocol-zcode/src/fork/completed_activity_tests.rs` (count rules),
`packages/rust-cli/crates/protocol-zcode/src/fork/subagents_tests.rs` (`ended_outcomes`),
`packages/rust-cli/crates/protocol-zcode/src/server_activity_cold_tests.rs` (rewind),
`packages/rust-cli/crates/node-store/src/repo/dwf/activity_history_tests.rs` (journal index),
`packages/rust-cli/crates/runtime/src/workflow_run_store_tests.rs` (the port read), and the `Live` wiring tests.
