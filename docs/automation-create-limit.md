# Automation create limit

## Product semantics

- A single local task index keeps at most `20` automation definitions.
- The count scope matches the management page's `listAllAutomations()`: all projects, not 20 per workspace.
- All lifecycle states — `active`, `paused`, `completed`, `failed` — occupy quota.
- Off-peak tasks are a separate domain and do not count toward the 20-automation limit.
- Updating, running, pausing, and resuming existing tasks are unrestricted; only deleting an automation definition releases quota.
- Every creation entry point — manual form, template, session `CronCreate` — obeys the same limit.

## Boundary and ordering

The UI pre-blocks creation from the fully loaded list and shows an internationalized message; that check is interaction feedback only, not the final consistency boundary. The service-level create is ultimately serialized by a SQLite write transaction that re-checks the total count, so desktop multi-window or session-tool concurrent creation cannot both pass on a stale count.

```text
UI / CronCreate
      |
      v
AutomationService.create
      |
      v
BEGIN IMMEDIATE
      |
      +-- COUNT(all lifecycle states) >= 20 --> rollback + limit error
      |
      +-- COUNT < 20 --> INSERT --> commit
```

At the limit, do not auto-clean completed or failed tasks, and do not filter the count by workspace, state, or enabled.

## Session tool failure boundary

A `CronCreate` that hits the global limit is a product limit the Agent cannot recover from itself, not an ordinary retryable tool error:

- The create modifies no task.
- Remaining unexecuted tool calls in the current model step must be cancelled.
- The current user turn allows exactly one more model reply without tools, stating in the current language that the limit is reached and directing the user to the Automations page (「自动化」) to delete a task manually and retry.
- That reply stage must not expose `CronList`, `CronDelete`, `CronCreate`, Bash, or other bypass entries.
- The Agent must not select, delete, or overwrite existing tasks itself; even if the current workspace's `CronList` shows fewer than 20, that does not infer other workspaces' global quota or justify cleanup.

```text
CronCreate limit error
       |
       +-- cancel remaining tool groups in this model step
       |
       +-- lock all tools for the rest of this user turn
       |
       +-- one text-only response: explain limit and manual next step
```
