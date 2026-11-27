# zcode-rs: Activity capsule boundary (`activitySummaryDismissed`)

Upstream 4.0.0 added `activitySummaryDismissed` to the v4 snapshot and `state.updated` patch
(`packages/shared/src/zcode-protocol-v4/snapshot.ts`). The Node CLI sets it in
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`; the product rule is in
`docs/ui/chat-summary-panel.md` (Activity capsule) and
`apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` ("Activity 轮次展示边界"). zcode-rs did not send
the field, so on Rust the Activity capsule kept showing a finished batch (for example a stopped run as
"Stopped") after the next real message, and the history directory entry never appeared. Found by
`conversation-session-dynamic-workflow-gray-always-on-resume.test.ts` DWU-03 in the Linux box
(Node 4/4, Rust 2/4, 2026-11-26).

## Rules

1. Owner: the session's `Live` state in `packages/rust-cli/crates/protocol-zcode/src/live.rs`. It is the only place
   that sees the background works and the subagent manifest (from the projection) and the session's workflow runs
   (folded from the run deltas) together. The pure rules live in `fork/activity_summary.rs`.
2. Set: when a projected kernel event appends a `userInput` row with `origin: "realUser"` (a typed message or a
   guided steer), the session records
   `{at: <event time ms>, workIds, subagentIds, workflowRunIds}`:
   - `workIds`: `backgroundWorks` items whose `status` is not `running`;
   - `subagentIds`: `subagents.childSessionIds` minus the children in `subagents.running`;
   - `workflowRunIds`: workflow runs whose `status` is neither `running` nor `pending`.
     All four keys are always present. Every new real input replaces the value. A background result, a workflow
     notice, a launch record or any other non-`realUser` row never sets it.
3. Release: an id leaves the value as soon as its item runs again: a work back to `running`, a child back in
   `subagents.running`, a run back to `running` or `pending` (resume keeps the run id, so the resumed result is
   shown again). The check runs before every write of the session, so every path that changes those facts
   (kernel events, background ledger re-read, run deltas, subagent table) is covered by one rule. Ids are only
   removed, never added, outside rule 2.
4. Delivery: the value goes out as `state.updated {activitySummaryDismissed}` in the same frame as the change,
   and the session's snapshot carries it, so a renderer reload and the mobile `web-remote-replayable` replay see
   the same boundary as the desktop `desktop-continuous` stream.
5. Cold seed: a session opened from storage (a new process) has no boundary yet. When the stored history holds a
   real input and the session's own boundary is still unset, the full-history seed of
   `specs/fork-rust-completed-activity-count.md` (rule 2) also sets it, in the same pump task and frame as the count:
   - `at`: the admission time (`admittedAt`, ms) of the last real input, read from its stored input intent. A typed
     message and a steer absorbed into a running turn (a guided row) both count. An input with no intent (typed in the TUI or the CLI) has no time: `at` is then the session's creation
     time, so children that ended after it stay visible;
   - `subagentIds`: the ended children of the active branch (the store classification) whose own completion time is not after
     `at`. A background Agent's tool part ends at its launch acknowledgement, so the child's last completion wins
     over the part's end when both exist;
   - `workflowRunIds`: the journaled runs whose physical status is neither `running` nor `pending` and whose last
     event (or last update, when it has no event) is not after `at`;
   - `workIds`: always empty. Background commands are in-process facts and nothing persists them.
     A live boundary (rule 2) is never replaced by the seed. A failed seed sets nothing and the next seed retries.
     Rule 3 runs on the seeded value like on any other.
6. Records are never deleted; the UI only folds finished details and shows the history directory.

```text
kernel event ──► Projection.apply ──► deltas ──┐
                                               ├─► Live: realUser row appended? ──► set boundary (rule 2)
run deltas ──► Live.workflow_runs ─────────────┤
ledger / subagent table ──► Projection ────────┘
                                   Live.collect ──► release running ids (rule 3) ──► frame + snapshot
```

## Divergences from Node

- Cold open: Node rebuilds the boundary while it replays the stored events (each real input sets it from what the
  replay knows then) and a cold child seed archives children that ended before it. zcode-rs has no event replay and
  no per-message time, so rule 6 derives the same value from the stored facts (see its limits).
- `completedActivityCount` has its own spec: `specs/fork-rust-completed-activity-count.md` (full-history seed from the
  workflow journal and the store's subagent classification, live updates from the subagent table and the run deltas).

## Acceptance

- A stopped run, then a real message: the snapshot has `workflowRunIds: [<run>]` and the capsule shows the
  directory entry with "0" completed (DWU-03 step before the resume).
- A workflow notice or background result row does not set the boundary.
- The same run resumed: its id leaves `workflowRunIds` before its completion, and the completed result shows.
- A running work, child or run is never in the value.
- A cold open of a session whose last turn followed an ended run and an ended child: the first snapshot after the seed
  carries both ids with `at` = the last input's admission time; a child that ended after that time is not in it.

Coverage: `packages/rust-cli/crates/protocol-zcode/src/fork/activity_summary_tests.rs` (rules, cold seed),
`packages/rust-cli/crates/protocol-zcode/src/server_activity_cold_tests.rs` (the open's seed),
`packages/rust-cli/crates/protocol-zcode/src/server_close_tests.rs` (set, release, kernel messages ignored),
`conversation-session-dynamic-workflow-gray-always-on-resume.test.ts` on Rust in the Linux box (4/4 on 2026-11-26, was 2/4).
