# Windows Agent process-tree cleanup state machine

## Background

The desktop Host starts an Agent CLI for every workspace. Closing a workspace, restarting the runtime,
Computer Use Helper credential rotation and App exit must all reclaim the Agent root process and the
runtime/MCP descendants it spawned. Windows does not use POSIX process groups; it closes out the process
tree with `taskkill /T` and the identity-rechecked `taskkill /T /F`.

The existing wait path is below; do not add a second wait semantic:

```text
ZCodeAgentProcessManager
  -> ZCodeProtocolClient.disposeAndWait
  -> ZCodeStdioTransport.disposeAndWait
  -> terminateProcessTreeAndWait
  -> waitForProcessTreeTermination
```

The non-waiting `terminateProcessTree` is still used for best-effort dispose; a waiting call must obtain
and observe the taskkill flight within the same path.

## Confirmed defects

Runtime logs confirmed three stacked races:

1. A waiting reclaim started the graceful `taskkill /T` without exposing its flight, so the waiter could not observe command completion;
2. When `taskkill /F` had succeeded and the OS PID was gone, the Node `ChildProcess.exit` event could be
   delivered 1-10 ms late; after the waiter returned success, the transport appended the root PID back
   to the residual result using the lagging `exitCode`;
3. The process-table query shared by multiple workspaces could start before a new Agent spawn. If the
   new root's cleanup reused that stale table, it could not find itself, then correctly failed closed,
   and for that reason could not send taskkill.

All three are cleanup state-machine implementation errors, not app auto-update logic and not the user still running ZCode.

## Safety invariants

1. A PID is only a number and does not prove ownership; before a force kill the process creation
   identity must match, or ownership must be proven by the Host-held managed `ChildProcess` live root
   handle. The handle exception applies only to the root, not to descendants.
2. When identity query fails or times out, unverified descendants and `unverifiedRootOnly` must fail
   closed, and `/F` must not be sent to a bare PID. A managed root not in `unverifiedRootOnly` whose
   handle still confirms it alive is not a bare PID.
3. The pre-exit process-tree snapshot remains the only basis for claiming descendants after the root exits.
4. Non-waiting reclaim must not block the Host event loop.
5. Multi-workspace reclaim must run concurrently; do not restore synchronous or per-workspace serial taskkill.
6. Only a PID still belonging to the original process tree after the absolute deadline is a confirmed residual.
7. A confirmed residual must keep reporting an error to the caller; a real cleanup failure must not be swallowed.

## State machine

```text
running
  -> snapshot-query
       |-> query-started-after-root -> verified snapshot
       `-> query-started-before-root -> start fresh query
  -> stdin-eof-requested
  -> graceful-taskkill-in-flight
       |-> os-tree-exited -> wait-child-exit-event ----------> success
       `-> force-deadline
            -> verify-current-identities-in-parallel
                 |-> verified root/descendant -> force-taskkill-in-flight
                 |-> managed root handle live -> root-only force-taskkill-in-flight
                 `-> unverified descendant/root-only -> skip-that-pid-and-observe
                                      |
                                      |-> child-exited ------> success
                                      `-> cleanup-deadline --> confirmed-residual
```

`graceful-taskkill-in-flight`, the force flight and the ChildProcess `exit` must be observed concurrently.
A taskkill command returning does not mean Node has delivered the exit event; conversely, the root exiting
does not mean all descendants in the snapshot have exited.

## Deadline contract

Waiting Windows reclaim uses two upper bounds and takes the earlier one:

1. The transport fixes one whole-chain absolute deadline from the cleanup start of `disposeAndWait`,
   covering process-table snapshot, stdin EOF, taskkill and exit observation;
2. The waiter still computes this phase's relative deadline from the ownership state already fixed, to
   avoid waiting for nothing when there is no signal target.

```text
transportDeadlineAt = cleanupStartedAt
  + forceBudgetMs
  + windowsTaskkillTimeoutMs
  + boundedExitObservationGraceMs

waiterDeadlineAt = waiterStartedAt
  + remainingForceAfterMs
  + ownedTargetTaskkillBudgetMs
  + boundedExitObservationGraceMs

effectiveDeadlineAt = min(transportDeadlineAt, waiterDeadlineAt)
```

The waiter's taskkill budget is allocated by the ownership state already fixed:

```text
                         +---------------------------+
                         | at least one verified      |
                         | signal target?             |
                         +-------------+-------------+
                                       |
                 +---------------------+---------------------+
                 | yes                                       | no
                 v                                           v
waiterDeadline = waiterStartedAt                waiterDeadline = waiterStartedAt
  + forceAfterMs                                  + forceAfterMs
  + windowsTaskkillTimeoutMs                      + boundedExitObservationGraceMs
  + boundedExitObservationGraceMs
```

- `forceAfterMs` defaults to 2,000 ms.
- The process layer's default single-taskkill cap is 2,000 ms; the ZCode transport's waiting path explicitly uses 1,000 ms.
- The graceful taskkill runs concurrently with the force timer from the start of the wait; no timeout is
  stacked for each of the graceful and force commands, and the deadline keeps only one terminal taskkill
  cap after the force margin.
- When identity query is unavailable and there is no verified identity, the target sets of graceful and
  force are necessarily empty; no taskkill timeout is reserved for a nonexistent command, and only the
  force margin and the exit observation grace are kept.
- As long as any verified target exists, the waiter's relative deadline keeps the full taskkill budget.
  The boundary must not be shortened ad hoc by whether a Promise has settled at some moment; but the
  transport's whole-chain absolute deadline remains the hard cap, and time already consumed by a slow
  snapshot must not be added back.
- `boundedExitObservationGraceMs` only absorbs the delivery gap between the taskkill callback and the
  ChildProcess exit event and must not become an unconditional sleep.
- The identity recheck is still covered by the force budget and is not an extra serial period.
- Before force, the root and each descendant in the initial ownership must be rechecked in a targeted way
  concurrently within the same bounded window; only an identity whose CreationDate still matches can enter
  the generic `/F` target set. The one exception is a root not in `unverifiedRootOnly` whose original
  managed `ChildProcess` still has `exitCode/signalCode` both `null`, whose handle can send signals and
  confirm the PID is alive: if the targeted recheck did not complete, `/T /F` is allowed on that root, but
  descendants must not be rediscovered or claimed along that PID. A failed identity recheck of a single
  descendant only skips that PID and must not block other verified targets from closing out.
- Multiple workspaces reclaim in parallel under the same relative deadline, and total wait time must not
  grow with the workspace count.
- At cleanup start the transport fixes a deadline of `cleanupStartedAt + 2,000 + 1,000 + 250 = 3,250 ms`
  and passes it to the waiter. Even if the CIM snapshot and EOF have used up the force window, the waiter
  can only use the remainder of this deadline, so the whole-chain hard cap stays 3,250 ms, below the
  3,500 ms service-dispose phase of the desktop Host and the server stdio lifecycle.

## Testability boundary

The Windows taskkill runner is a process-layer dependency and its default implementation still uses
async `execFile`. Tests may inject a runner to control started, completed, failed and hung timing, but
injection must not bypass production PID identity checks.

Must cover:

- no early residual report while the graceful taskkill has not completed;
- success when exit arrives 1-10 ms after taskkill completes;
- a new root does not reuse a shared process table that started before its own spawn;
- on PID reuse or identity query failure, no `/F` to an unverified descendant or `unverifiedRootOnly`; the
  managed live root handle exception may only send root `/T /F` and cannot bring descendants into the explicit `/F` target set;
- on a targeted CIM recheck failure, the managed live root handle still triggers root-only `/F` while unverified descendants are skipped;
- while the graceful flight hangs, force sends `/F` separately to the root and descendants that still
  match this time, and skips descendants whose PID was reused;
- return remaining PIDs when the deadline arrives and an original-identity PID is still alive;
- when the CIM snapshot takes longer than the force window, taskkill/exit observation must not reset the whole-chain deadline backward;
- multi-workspace taskkill concurrency;
- workspace restart, App quit and CUA Helper credential rotation reuse the same state machine.

## Diagnostics

Low-frequency cleanup logs should record taskkill started/completed/failed, identity verification results,
force skip reasons, exit observation, deadline and remaining PIDs. Logs must not contain prompts, tokens or user content.

## Verification record (2026-08-24 and 2026-08-25, summary)

Under real Windows permissions, 10 consecutive rounds of `zcodeAgentProcessManager.test.ts` passed 360/360;
the process terminator + stdio transport + manager test set passed (55 passed / 11 skipped, later 59 passed /
11 skipped); the root/descendant targeted identity recheck/force timing passed 10 rounds (160/160). The
deterministic cases cover taskkill flight, exit delay, additive deadline, PID reuse (a mismatching identity
receives no `/F` while other matching targets still close out concurrently, and an unconfirmed old identity
keeps failing closed instead of being judged successful), identity query failure and shared process-table
freshness; the unverified branch with no signal target reserves no taskkill timeout, while an unverified
branch with a verified descendant keeps the full timeout. No test-spawned Node Agent orphan was found after
the 10 rounds. `pnpm typecheck` and `pnpm lint` passed (110 unrelated pre-existing lint warnings). A
restricted sandbox without permission to read `Win32_Process` enters unverified fail-closed by design, so
Windows real-machine process-tree regression must run in a test environment with CIM read permission.
Full history: `git show 37b98ff8:docs/windows-agent-process-cleanup-state-machine.md`.
