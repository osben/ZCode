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
5. Records are never deleted; the UI only folds finished details and shows the history directory.

```text
kernel event ──► Projection.apply ──► deltas ──┐
                                               ├─► Live: realUser row appended? ──► set boundary (rule 2)
run deltas ──► Live.workflow_runs ─────────────┤
ledger / subagent table ──► Projection ────────┘
                                   Live.collect ──► release running ids (rule 3) ──► frame + snapshot
```

## Divergences from Node

- Cold open: Node rebuilds the boundary while it replays the stored events, and a cold child seed archives
  children that ended before it. zcode-rs builds a cold projection from the session view, not from an event
  replay, so a reopened session has no boundary until the next real input. Finished items of the last batch show
  again after a restart.
- `completedActivityCount` is not sent. Node derives it from full-history child and run outcome indices with
  journal cold seeds, rewind cuts and transactional rollback. zcode-rs has no full-history source yet (its
  subagent manifest has no ended previews and its run state is the bounded preview). Sending a count built from
  previews would be worse than omitting the field: the UI trusts the number over its own preview fallback. With
  the field absent the UI uses the preview count, the path the schema keeps for older CLIs. Open follow-up.

## Acceptance

- A stopped run, then a real message: the snapshot has `workflowRunIds: [<run>]` and the capsule shows the
  directory entry with "0" completed (DWU-03 step before the resume).
- A workflow notice or background result row does not set the boundary.
- The same run resumed: its id leaves `workflowRunIds` before its completion, and the completed result shows.
- A running work, child or run is never in the value.

Coverage: `packages/rust-cli/crates/protocol-zcode/src/fork/activity_summary_tests.rs`,
`packages/rust-cli/crates/protocol-zcode/src/server_close_tests.rs` (set, release, kernel messages ignored),
`conversation-session-dynamic-workflow-gray-always-on-resume.test.ts` on Rust in the Linux box (4/4 on 2026-11-26, was 2/4).
