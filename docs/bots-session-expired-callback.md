# Bot expired session callback prompt

## Background

Bot users may tap a stale message button or keep sending messages on an inactive task. The ZCode Agent protocol then returns `Session not found: <id>` / `Session is not active: <id>` when resuming the task. Wrapping that as a generic callback failure (处理机器人回调失败) leaves the user without a next step.

## Rules

- When the provider callback chain hits a missing or inactive session error, do not return the underlying session id to the user.
- The user-facing message says the current task session has expired and guides the user to send `/new task`.
- Logs keep the original error for debugging task index, workspace identity, remote connection, or session store inconsistencies.
- Background prompt sends that hit the same errors use the same friendly message, so raw errors never leak from the background path.

## Acceptance

- `Session not found: <id>` no longer appears as user-visible text in bot callbacks.
- The user-visible reply includes `/new task` guidance.
- Task/session protocol, workspace identity, and remote continuous/replayable semantics are unchanged.
