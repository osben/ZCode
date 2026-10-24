# Runtime Command Active Loop Intake

> Historical implementation plan (2026-07-04), implemented. Kept for the task-notification
> active-loop intake contract.

**Goal:** Background task completion `<task-notification>` still enters the runtime command
queue, but an active query loop consumes pending runtime commands by command priority before
the next legitimate model request boundary; an idle runtime keeps the existing idle wake /
next command behavior.

## Queue Semantics

- Command priorities: `now = 0`, `next = 1`, `later = 2` (smaller rank = higher priority).
- `RuntimeCommandQueue.getByMaxPriority("next")` returns pending commands with
  `RUNTIME_COMMAND_PRIORITY_ORDER[command.priority] <= RUNTIME_COMMAND_PRIORITY_ORDER[maxPriority]`
  in existing priority order (FIFO within the same priority) without removing them; the
  consumer removes a command by id via `removeById()`.
- The queue layer never filters by command mode; mode-specific behavior lives only in the
  runtime intake processor.

## Active-Loop Intake

- Wired into `runRegularTurnLoop()` only for post-first-request active-loop roundtrips
  (`modelStepCount > 0`), after steer drain and before compact/provider projection
  (`buildRuntimeProviderRequestMessages`).
- Candidates are taken by priority rank `<= rank(next)` (i.e. `now` and `next`), then filtered
  by an explicit whitelist. Only `task-notification` passes; `prompt`, `target-continuation`
  and `target-continuation-loop` stay in the outer runtime command queue with their existing
  execution semantics and promise lifecycle. Nothing is silently swallowed.
- `task-notification` is persisted through `persistBackgroundTaskNotificationCommand()` as a
  model-only synthetic input; the intake does not call `executeTurnCommand()`, does not
  create a new turn, and does not trigger `runPostCommandActiveTargetLoop()`.
- Notifications never interrupt an in-flight provider request and are never injected between
  tool executions.

## Idle Wake Fallback

- An idle runtime keeps the existing command queue path: a `task-notification` command calls
  `executeTurnCommand()` and wakes a model-only synthetic notification turn that never leaks
  into user-visible content.
- Post-notification goal continuation in `runtime-command-queue.ts` serves only idle
  notification commands and does not affect active-loop intake.

## Goal Interaction

- Goal verification waits for running background tasks (`RuntimeTaskRegistry`) to settle and
  runs only after notifications are consumed; queued prompt commands keep priority over
  post-notification goal loop iterations.
- When `targetCompletionVerification.enabled === false`, a notification never unconditionally
  starts an active target continuation.

## Subagent Child Runtime

- A child runtime that is still active consumes nested Bash notifications at its own next
  provider request boundary; the parent Agent result is never rewritten by later nested Bash
  results.
- After the child runtime is terminal/sealed, nested Bash completion performs only terminal
  record / artifact / event cleanup: no child `<task-notification>` model turn, no child
  model request, no rewrite of the parent Agent output, no second parent notification, and no
  pollution of the main runtime queue. The cleanup-only suppression judgment is shared
  between the active-loop and idle consumption sides.

## Compact And Visibility

- Compact keeps `<task-notification>` in provider-visible history as model-only synthetic
  input; it never becomes a real user message. Cache-control projection stays owned by
  `buildRuntimeProviderRequestMessages()`, and notification placement in provider requests is
  append-only.

## Boundaries

- Provider-visible content keeps the existing `<task-notification>` wording; the Bash single
  output-file surface, Workflow output-file artifact and manual background controls are out
  of scope.
- The background registry -> notification -> wake main chain was not rewritten; this change
  only closes the active-query intake gap.

## Known Limitation

- During implementation, `apps/zcode-cli` package-level `pnpm typecheck` /
  `turbo run typecheck` was blocked by workspace dependency resolution:
  `@zcode/shared@workspace:*` is referenced by `packages/adapters`, but the workspace only
  contains `@zcode/shared-types`.
