# Todo81: Scope Model-selection Migration Notices by Scenario

> Status: Complete
>
> Date: 2026-09-04

## Background

When a Model or Reasoning selection is invalid, the right behavior differs by scenario. The ordinary Composer does not need to expose migration failure for a historical selection. A completed off-peak task will not execute again, so continuing to show "repair required" only creates a sense of failure. Off-peak tasks that may still execute and scheduled tasks must retain notice and protection so an invalid selection is never used silently later.

## Rule

```text
Regular Composer: invalid selection -> leave blank; no migration notice
Completed off-peak task: invalid selection -> no repair-required; keep normal terminal state
Unexecuted/paused/possibly resumable off-peak task: invalid selection -> keep notice and block invalid scheduling
Scheduled task: invalid selection -> keep notice and require reselection
```

## Scope

- Composer: an invalid Model selection is left blank; an invalid Reasoning selection keeps the Model and clears Reasoning; no migration-failure Toast, dialog or banner.
- Off-peak tasks: show `modelSelectionIssue` only when the task may still execute (not on completed, failed or canceled historical tasks).
- Scheduling protection for unexecuted off-peak tasks is kept: hiding the notice must not let an invalid Model execute silently.
- Scheduled tasks keep the existing invalid-selection notice, save protection and execution protection.
- Remove redundant branches/tests used only for Composer or completed-off-peak notices; do not remove normal action-error feedback for Wiki, Bot, Subagent, title, Goal or Git.
- No change to Provider/Model identity migration rules, no additional selection state, and Wiki's explicit "selection unavailable" message is not changed to Composer semantics.

## Acceptance

- An invalid Model or Reasoning in Composer shows no repair notice; choosing valid config again allows sending.
- Completed, failed and canceled off-peak history keeps its terminal state without a misleading repair error.
- Unexecuted, paused or potentially resumable off-peak tasks keep the notice and are not scheduled.
- Scheduled tasks keep the notice and require a valid Model selection before saving or executing.
- Real action-error feedback for Wiki, Bot, Subagent, title, Goal and Git is unchanged.
- Focused tests for Composer, off-peak and scheduled tasks; invalid selection is not hidden by weakening assertions.

## Relationship to existing Todos

- Absorbs the earlier Composer-draft scope; no separate pending Composer item.
- Todo70 owns reading old Session data, restoring an empty selection when invalid and not blocking historical opens; this Todo ensures those results show no migration-repair notice in Composer.
- Todo72 owns migration of old Provider/Model identities and task-selection safety boundaries; this Todo only distinguishes notices for terminal versus executable off-peak tasks.

## Outcome (2026-09-04)

- Added `shouldShowOffPeakModelSelectionIssue`: only queued, paused and running tasks that may still execute show "Model configuration needs an update."
- Completed, failed, canceled and other terminal tasks keep their records and terminal copy without a misleading repair notice.
- List cards and the edit page use the same judgment; the scheduler behavior blocking invalid Selection is unchanged.
- Focused verification: 3 files, 39 tests; `pnpm typecheck` and `pnpm lint` pass (0 errors).
