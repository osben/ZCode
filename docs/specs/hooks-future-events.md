# Future Hook Events (Backlog)

> Status: backlog / planning. Candidate hook events and research conclusions; nothing here is implemented.

## Purpose

Compares the hooks of Claude Code, Codex and DeepSeek Harness (dsh) and records candidate events ZCode does not support yet but that have confirmed real usage. No event may appear in the config schema, settings UI, plugin allowlist or supported-event docs until it is promoted into `docs/hooks-runtime-contract.md`. ZCode currently supports 10 events (see the contract doc); this file tracks the remaining candidates only.

## Overview

| Candidate event  | Claude Code | Codex | dsh CC bridge | Conclusion                           |
| ---------------- | ----------- | ----- | ------------- | ------------------------------------ |
| `SubagentStart`  | yes         | yes   | yes           | worth doing, medium effort           |
| `SubagentStop`   | yes         | yes   | yes           | same batch as SubagentStart          |
| `Notification`   | yes         | no    | no            | questionable value, defer            |
| `Interrupt`      | no          | yes   | no            | Codex only, defer                    |
| `WorktreeCreate` | yes         | no    | no            | architecture issue, separate project |
| `WorktreeRemove` | yes         | no    | no            | same batch as WorktreeCreate         |

Claude Code has many more events with no ZCode counterpart (`TaskCreated` / `TaskCompleted` / `TeammateIdle` / `ConfigChange` / `FileChanged` / `Elicitation` etc.); they are not candidates until ZCode has the matching product concept.

## Candidate Details

### SubagentStart / SubagentStop

- Semantics (Claude): Start only injects `additionalContext`; Stop may block (exit 2 / `decision:"block"`) to make the subagent run another round; matcher is the agent type.
- Existing hook points: all subagent lifecycle events converge in `emitSubagentEvent` (`apps/zcode-cli/packages/core/src/subagent/runner.ts`). `SubagentSpawned` fires at foreground start in the session-ready callback; `SubagentStopped` fires at several completion/failure/cancel/background-finish points.
- Risk: many emit points (foreground/background × success/failure/cancel); each must be wired and block semantics must not break the finish paths. The matcher subject currently has only `general-purpose`.
- Effort: medium. The registration surface (contracts/shared/services/UI/adapters) is mechanical and costs the same as the PreCompact batch; the main cost is semantic tests at the runner.ts finish points.

### Notification

- Semantics (Claude): permission waits, idle reminders and similar; no decision power, side effects only.
- Current state: OS notifications are owned by the desktop main process (`packages/desktop/src/main/desktopNotifications.ts`, `TaskNotificationPayload`); the agent runtime has no single notification choke point, and the permission case overlaps heavily with the `PermissionRequest` hook.
- Conclusion: defer. If done, hook it on the `PermissionRequested` session event and first define de-duplication against desktop notifications to avoid double alerts.

### Interrupt

- Semantics (Codex): fires when the user interrupts an active turn; cannot prevent the interrupt; 1s default / 3s max timeout.
- Existing hook point: `stopActiveForegroundExecution` (`apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`) is the single choke point.
- Conclusion: defer. Only Codex defines it, so ecosystem-compatibility gain is low. If done later, copy Codex semantics (non-blocking, very short timeout).

### WorktreeCreate / WorktreeRemove (needs an architecture decision)

- Semantics (Claude Code): provider-type hooks. They fire when `--worktree` / `isolation:"worktree"` / a background session creates a worktree. The command hook creates the worktree itself and prints the path to stdout (stdout is read as the path, JSON cannot be returned); any non-zero exit fails creation. `WorktreeRemove` fires only for hook-created worktrees; non-zero exit fails removal; JSON output is discarded. Neither has a matcher.
- ZCode today: worktree create/remove happen on the desktop host side (`packages/services/src/git/repo/gitCliRepo.ts` `createWorktree` / `removeWorktree`, orchestrated in `packages/ui/src/command-center/worktreeCreation.ts`), before the agent process spawns, so the target agent does not exist and the parent workspace agent is not guaranteed alive. All hook execution (runner, config merge, trust admission, settings page) lives in the `apps/zcode-cli` agent process.
- Options:
  1. Extract a headless hook runner in `packages/services` and have the host run hooks before/after `git worktree add`. Gives full provider semantics but is a separate project (second execution surface, config ownership and trust model to define).
  2. Forward through a live parent workspace agent process. Fragile timing; not recommended.
  3. Downgrade to after-the-fact notification events `WorktreeCreated` / `WorktreeRemoved` (cannot replace git behavior). Cheap but loses the core value (custom provisioning, `.env` copy, remote builders).
- Conclusion: separate project. The option and owner must be settled in a spec before any code.

## Promotion Process

1. Complete the candidate in this file: product rules, stdin fields, output effects, matcher subject, failure semantics, acceptance scenarios.
2. Move the event into `docs/hooks-runtime-contract.md` (event list, stdin table, effect matrix and acceptance matrix updated together).
3. Land it in the existing batch pattern: contracts → shared → services/UI/adapters registration surface → core payload/output → dispatch points → tests (contract test + targeted runtime tests) → docs (README / NOTICE / e2e matrix / settings-hook-list).
