# Goal Command While Running (current state)

`/goal` uses V4 `sendGoalCommand`. It keeps the user-visible original command text and updates goal state inside the CLI; the UI no longer bypasses input admission by calling the old `session/goal` directly.

## Rules

- When the session is ready, `sendGoalCommand` executes immediately.
- With an active turn, the command enters the CLI runtime queue under its own `sendGoalCommand` identity. It is not rejected, does not jump the queue and does not interrupt the current turn.
- With a held queue, `inputRouting.mode = choice` applies: the user explicitly chooses to keep or clear the existing queue before sending.
- The command executes only when the CLI decides it can be consumed. The UI does not infer readiness from assistant row end, a verification marker or a local timer.
- Goal pause/resume, the stop barrier and automatic continuation are decided by the CLI reducer/command handler.

```text
/goal input
  -> sendGoalCommand
  -> active turn?
       ├─ no  -> execute now
       └─ yes -> enqueue as goal command
  -> authoritative queue/goal projection
  -> desktop and mobile converge
```

Entry point: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts`.
