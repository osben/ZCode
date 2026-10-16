# Todo81: Scope Model-selection Migration Notices by Scenario

> Status: Complete
>
> Date: 2026-09-04

## Background

Subsequent behavior differs when a Model or Reasoning selection is invalid. The ordinary Composer does not need to expose migration failure for a historical selection. A completed off-peak task will not execute again, so continuing to show “repair required” only creates a sense of failure. Off-peak tasks that may still execute and scheduled tasks must retain notice and protection to avoid silently using an invalid selection later.

## Goal

```text
Regular Composer
  Invalid selection → leave blank; show no migration notice

Completed off-peak task
  Invalid selection → do not show repair-required; keep normal terminal state

Unexecuted/paused/possibly resumable off-peak task
  Invalid selection → retain notice and block invalid scheduling

Scheduled task
  Invalid selection → retain notice and require reselection
```

## Implementation Scope

- Finish the actual Composer scope for Todo81: when Model selection is invalid, leave it blank; when Reasoning selection is invalid, keep the Model and clear Reasoning; show no migration-failure Toast, dialog, or banner.
- Adjust invalid-selection display for off-peak tasks: show `modelSelectionIssue` only when the task may still execute. Do not show it on completed, failed, or canceled historical tasks.
- Preserve scheduling protection for unexecuted off-peak tasks; hiding the notice must not make an invalid Model execute silently.
- Preserve existing invalid-selection notice, save protection, and execution protection for scheduled tasks.
- Remove redundant branches/tests used only for Composer or completed-off-peak notices. Do not remove normal action-error feedback for Wiki, Bot, Subagent, title, Goal, or Git.
- Do not change Provider/Model identity migration rules, add another selection state, or change Wiki's explicit “selection unavailable” message to Composer semantics.

## Acceptance

- An invalid Model or Reasoning selection in Composer does not show a migration-repair notice; selecting valid config again allows sending normally.
- Completed, failed, and canceled off-peak history retains its original terminal state and no longer shows a misleading model-selection repair error.
- Unexecuted, paused, or potentially resumable off-peak tasks retain the invalid-selection notice and are not scheduled.
- Scheduled tasks retain the notice and require a valid Model selection before saving or execution can continue.
- Real action-error feedback for Wiki, Bot, Subagent, title, Goal, and Git remains unchanged.
- Add/update focused tests for Composer, off-peak, and scheduled tasks; ensure invalid selection is not hidden by weakening assertions.

## Relationship to Existing Todos

- This Todo absorbs the earlier Composer-draft scope; do not keep a separate pending Composer item.
- Todo70 owns reading old Session data, restoring an empty selection when invalid, and not blocking historical opens. This Todo ensures those results do not show a migration-repair notice in Composer.
- Todo72 owns migration of old Provider/Model identities and task-selection safety boundaries. This Todo distinguishes notices for terminal versus executable off-peak tasks without changing migration rules.

## Implementation Record (2026-09-04)

- Added `shouldShowOffPeakModelSelectionIssue`; only queued, paused, and running tasks that may still execute show “Model configuration needs an update.”
- Completed, failed, canceled, and other terminal tasks keep their original records and terminal copy but no longer show a misleading repair-required notice.
- List cards and edit page use the same judgment. Scheduler behavior that blocks invalid Selection is unchanged.
- Focused verification passed: 3 files, 39 tests; then `pnpm typecheck` and `pnpm lint` passed (0 errors).
