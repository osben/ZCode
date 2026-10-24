# Background Task Control Parity

> Historical implementation plan (2026-07-04), implemented and archived. Kept for the
> background task stop control contract and the intentionally deferred scope.

**Goal:** Provide user-triggered stop/cancel for already-background `local_bash` and
`local_agent` tasks, plus the provider-visible `TaskStop` tool. The implementation reuses
`RuntimeTaskRegistry`, background notification, the runtime command queue, session projection
and `session/cancelBackgroundTask`; it adds no second background manager, poller, wake path or
UI stop path.

## Final Architecture

- Registry-first background task stop dispatcher inside the runtime; `TaskStop` and
  UI/session cancel share the same dispatcher.
- `local_bash` stop dispatches to `ExecutionPort.cancelBackgroundTask(taskId)`;
  `local_agent` stop dispatches to `SubagentPort.stopTask(taskId)`.
- `TaskStop.command` semantics: `local_bash` uses the actual command, `local_agent` uses the
  short `description`; the full subagent `prompt` never enters the stop result.
- Terminal state still flows registry terminal update -> task notification -> runtime command
  queue.
- SummaryPanel is the single background task control surface; Bash and Agent tasks share the
  same stop button behavior and protocol call. `AgentToolCallBlock` only renders background
  Agent details and does not duplicate the stop request logic.
- The stop RPC ACK only means the runtime accepted the stop request; UI stop pending is
  released only after the task is no longer active. The stop button is disabled per task
  while stop is pending.
- The `session/cancelBackgroundTask` protocol name is kept to avoid protocol churn.
- Stop and natural completion are terminal-idempotent for Bash and Agent; `notified` is
  marked only after notification enqueue succeeds. Goal defer reads running background tasks
  from `RuntimeTaskRegistry`, not from UI projection.
- Missing or already-terminal tasks are handled idempotently on the UI/session side;
  `TaskStop` validation errors use strict/tool behavior.
- Snapshot/replay cache keys preserve `workspaceIdentity` / `workspacePath` semantics.

## TaskStop Tool Contract

- Input supports `task_id` and the deprecated `shell_id` alias; `KillShell` / `KillBash`
  aliases resolve through runtime lookup without becoming provider-visible tools.
- Validation returns distinct errors for missing id, task not found, and task not running.
- The result is JSON-compatible and exposes no internal snapshots/projections; the success
  message reuses the same `command` value in parentheses.
- Default child runtimes can expose `TaskStop` for runtime-local background tasks; custom
  profiles keep the existing allow/disallow filtering.

## Code Anchors

- `TaskStop` contract: `apps/zcode-cli/packages/contracts/src/tools/task-stop.ts`
- `TaskStop` model-facing handler: `apps/zcode-cli/packages/core/src/tool/handlers/task-stop.ts`
- Runtime background stop dispatch: `apps/zcode-cli/packages/core/src/runtime/methods/background.ts`
- UI/session cancel protocol: `session/cancelBackgroundTask` in `packages/shared/src/zcode-protocol/index.ts`
- Bash task stop: `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts`
- Agent task stop: `apps/zcode-cli/packages/core/src/subagent/runner.ts`

## Intentional Deferred Scope

Adjacent capabilities intentionally not implemented by this plan:

- SDK/control `background_tasks` foreground-to-background command.
- Ctrl+B or keyboard-triggered foreground-to-background conversion.
- `TaskOutput` / output retrieval.
- Single output-file convergence for Bash notifications.
- Manual controls for monitor/workflow unless product scope expands.
- Mobile Web replayable E2E promotion for this control surface; the implementation preserves
  `workspaceIdentity` / `workspacePath` boundaries, but mobile replayable promotion remains a
  separate validation item.
