# Task index: CLI-facts admission from sessions-index summaries

## Background

The sidebar project tree lists only task rows admitted with CLI facts
(`tasks.cli_created_at IS NOT NULL`, project storage membership). Upstream 3.16.2+
writes those facts from every persisted sessions-index summary
(`taskFacts.ingest` → `applyCliFacts`). The fork's task-index syncer kept an older
body that wrote CLI facts only for prepared sessions, fork children, and title
changes that carried `titleUpdatedAt`.

A session that got its title while its phase was still `draft` (a `/goal` started
from a draft pane, a cold-resumed task) therefore never reached `applyCliFacts`:
the later non-draft summary had the same title, and the became-visible, terminal and
snapshot paths write only organization columns. The row stayed invisible, and
`commitCreatedTask` (which waits for the row in the project tree) never resolved.

## Product rules

1. Every persisted, non-draft sessions-index summary is mirrored into the task index
   through `applyCliFacts`, the single writer of CLI facts. This covers the first
   visible summary, title changes, terminal transitions, and steady-state updates.
2. Untouched `draft` summaries stay out of the index. The Node gateway filters
   deferred prewarms at the source, but the Rust agent publishes a prewarmed session
   at once, so the Host filter stays.
3. Fork children (`parentSessionId`) keep their own admission (`admitForkSummary`):
   the fork claim must precede `applyCliFacts`. The generic mirror skips them.
4. Prepared sessions (`worktreePreparation` / `submissionPreparation`) keep their
   reservation seeding.
5. The mirrored meta follows upstream `taskFacts.ingest`: title, `titleUpdatedAt`,
   `createdAt`, `updatedAt = lastActivityAt`, `forkedFromTaskId`, `status` from
   `lastOutcome`, and `titleSource` / `lastOutcome` as CLI facts. `updated_at` stays
   CLI time (docs/ui/task-title-authority.md).

## Owners and event order

```text
CLI sessions-index summary (persisted, non-draft)
  -> Host syncer processSummary            (state.summaries baseline)
     -> mirrorSummary = applyCliFacts      (single CLI-facts writer, admits the row)
        -> became visible: task_created broadcast, then snapshot resync at grouped top
        -> title change:   applyAgentPatch(title) + task_title_changed
        -> terminal:       applyAgentPatch(status) + task_status_changed + snapshot resync
        -> steady state:   no broadcast
Renderer project tree re-reads on task_created -> commitCreatedTask resolves
```

Each path awaits the mirror before its follow-up write, so the snapshot resync
(`syncTaskMetaAtGroupedTop`) always sees an admitted row.

## Acceptance

- Unit (fork manifest): a summary that is `draft` with a title, then `running` with
  the same title, then `completed`, leaves the row with `cli_created_at` set and the
  project tree lists it; a `draft` → `completed` sequence does the same; an untouched
  `draft` summary writes no row.
- E2E: `conversation-session-goal`, `-goal-timeline`, `-goal-interruptions` and
  `context-window-cold-resume` pass on the Node agent; the three goal specs also pass on
  the Rust agent. `conversation-session-v4-vertical-slice` passes on both agents once the
  pane restore precedence fix (`specs/fork-pane-session-restore-precedence.md`) is in.
