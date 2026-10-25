# Background Task POSIX Process Tree Stop

- Date: 2026-08-14
- Status: accepted
- Type: bugfix

## Problem

`NodeExecutionAdapter` starts executions with `detached: true` on POSIX. The old stop logic sent `SIGTERM`
only to the process group of `-rootPid` and `SIGKILL` to the same group after 750ms.

Bash job control, pipelines, `xargs -P` or a PTY can put processes that are still descendants of the root PPID
tree into a different PGID. Signalling only the root process group leaves them running after `TaskStop` or
session close.

## Behavior contract

Only POSIX Bash process-tree stop is implemented. Windows, the TaskStop protocol, UI, background notification,
desktop continuous and web remote replayable behavior are unchanged.

```text
cancel / close
      |
      +--> async read `ps -A -o pid= -o ppid=` once (wait at most 500ms)
      |          |
      |          +--> SIGTERM root process group; on failure fall back to root PID
      |          +--> SIGTERM transitive PPID descendants in this snapshot
      |
      +--> fixed wait 1500ms
                 |
                 +--> SIGKILL root process group (best effort)
                 +--> re-read `ps` once, SIGKILL transitive descendants still under root
```

Rules:

1. Every process-tree signal first computes transitive PPID descendants from an independent `ps` snapshot of
   at most 500ms.
2. Each round signals the root process group first; on group failure fall back to the root PID; then signal
   each snapshot descendant with the same signal.
3. The first `SIGTERM` does not block the stop ACK; after 1500ms the `SIGKILL` escalation runs
   unconditionally, with no early exit polling.
4. Escalation uses a fresh PPID snapshot: it does not remember first-round descendants, reads no start time
   and adds no PID identity check.
5. If `ps` fails to start, errors or times out, treat descendants as the empty set; the root process
   group/root PID fallback still proceeds.
6. A single execution and the stop ACK do not explicitly await the escalation Promise; adapter shutdown waits
   for the registered 1500ms escalation timer and the escalated round's actual PPID snapshot/signal sending,
   and references the cleanup handle to keep the process alive. (2026-09-08: after direct-write Bash, pipes
   cannot be relied on for keep-alive, and awaiting a Promise alone does not stop Node from exiting.)
7. Windows keeps the existing `taskkill /T /F` path.
8. The contract applies only to Bash executions with `command.shellProfile === "posix-bash"`. Generic shell,
   argv, hook and custom command expansions keep the existing POSIX process-group stop: `SIGTERM` the root
   group immediately and, after 750ms, `SIGKILL` only if the group is still alive; no PPID descendant
   enumeration or Bash escalation registration for them.
9. Current Bash direct-write contract (2026-09-08): the execution settles when the root exits naturally, no
   longer enters foreground pipe drain, and does not actively clean up descendants. Bash process-tree stop is
   triggered only by real termination paths: task cancel, adapter close, abort/timeout and output limit. The
   shutdown keep-alive fix does not restore the historical drain behavior.

## Known limitations

Intentionally kept, not strengthened here:

- Cross-PGID descendants that were reparented after the first TERM and ignore TERM do not appear in the second
  PPID snapshot and may survive.
- There is no PID/start-time identity check between the snapshot and per-PID signalling.
- No cgroup, systemd scope, Windows Job Object, extra process ownership or new stop surface is added.

## Verification

- Real POSIX process test: background Bash creates a cooperative worker in its own PGID via job control; after
  stop both launcher and worker exit and the result settles as cancelled.
- Real POSIX process test: a generic argv execution creates a worker in its own PGID; cancel stops only the
  original process group, the worker stays alive (the test cleans it up), proving the Bash tree-kill policy
  does not spread to generic ExecutionPort callers.
- Current Bash direct-write regression: root natural exit settles, descendants may still write files and the
  test cleans up; the historical foreground Bash pipe drain is no longer required. Pipe drain and stop policy
  for generic argv/Hook stay.
- Standalone Node process regression: after abort, close, background Stop, timeout and output limit call
  adapter close, a TERM-ignoring same-group worker must terminate, and close must finish before Node exits,
  without relying on test-framework IPC keep-alive.
- Controllable clock regression: after the 1500ms timer fires, shutdown still waits for the async SIGKILL
  lookup and signal sending.
- Existing tests stay: same-group descendants, inherited pipe / foreground drain for generic execution,
  adapter close, Windows tree-kill.
- `pnpm typecheck` and `pnpm lint` must pass.
