# CUA Helper Recovery Period Agent Spawn Admission Gate (Historical Scheme, Obsolete)

> The `beginRecovery -> recycleUntilStable -> disposeWorkspace` scheme documented in this article has been
> superseded by the P0/P2 of `2026-09-02-helper-lifecycle-agent-runtime-isolation-spec.md`. The current default assembly no longer injects
> the Helper recovery gate into the Agent process manager; Helper ready/recovery must not block, recycle, or restart the Agent.
> The flow documented here is for incident review purposes only and must not serve as the basis for new implementations.

## Background and Problem Definition

3.9.1 exhibited "cannot converse after upgrade / all historical sessions unable to open" on Windows. Tickets
`ZCT-2092090611952312320` and `ZCT-2092131182991814656` share a common characteristic: during the Helper cold start or recovery period,
the Agent was already launched but received `BROKER_UNAVAILABLE`, and subsequently the Helper ready triggered a recycle; the UI, warmup, and recovery simultaneously
requested new Agents, causing old clients to still have in-flight promises writing back to the process pool after being disposed. The result is the same workspace
repeatedly spawning and `workspace-dispose`ing in quick succession, the conversation protocol client is in a disposed state, and neither the central content area nor the input box can be used.

This is not a Windows-exclusive protocol issue. Windows lacks POSIX `.pending` rendezvous, so the startup window between Helper and Agent is more
likely to be exposed; macOS may still trigger the same race during the Helper's first ready, credential rotation, and simultaneous workspace dispose. Therefore, the admission
barrier belongs in the Host/Agent shared layer and cannot be placed in a platform-specific Helper transport implementation.

## Objectives and Non-Objectives

Objectives:

- After Helper recovery/credential rotation begins, prevent new Agent child process spawns; startup requests already in the command/env resolution phase must re-check admission before the actual `spawn()`.
- Concurrent startups for the same workspace continue to merge into a single promise; workspace dispose must not lose in-flight startup promises from the tracking table.
- After recovery is completed and the current generation submitted, the admission opens once, and subsequent Agents start with the new Helper credentials.
- Maintain fail-closed: on recovery failure, agents with old broker state are not released; requests return retryable errors, handled by the existing UI's bounded retry.
- Desktop uses the `continuous` real-time link, web remote uses the `replayable` recovery link; this specification does not change the message delivery boundaries of either.

Non-Objectives:

- No new infinite retry loops added to the UI, and no task/session state pushed down to the relay or Main.
- Do not mask the race by extending the Helper cold-start grace; the Helper ready is still triggered by the existing watchdog/reconcile for recycling.
- Do not change the Windows named pipe or macOS POSIX rendezvous protocol format.

## State and Event Order

Each shared CUA Helper within the Host corresponds to one admission gate. The gate only protects Agent child process spawns;
it does not block the Helper's own startup/shutdown.

```text
                  beginRecovery(epoch)
       +----------------------------------------+
       |                                        v
   +--------+   close gate   +-----------------------+
   | OPEN   | --------------> | RECOVERING(epoch)   |
   +--------+                 +-----------------------+
       ^       commitRecovery / failRecovery |  ^
       |                                      |  |
       +--------------------------------------+  |
       waitForSpawnAdmission()                 |
       - OPEN: resolve                         |
       - RECOVERING: queue                      |
       - stale generation/dispose: reject      |
```

The correct order for recovery and startup:

```text
Helper unavailable/credentials rotated
        |
        v
gate.beginRecovery()  --->  disposeWorkspace() increments generation
        |                                      |
        |                                      +--> in-flight start cannot spawn
        |                                           and remains tracked until finally cleanup
        v
registry.recycleUntilStable(dispose, guardedCommit)
        |
        +--> all registered workspaces disposed
        +--> revision stable
        +--> guardedCommit() attempts to publish the current generation
        |
gate.commitRecovery() ---> queued starts re-check generation/env, then spawn once
```

## Implementation Contract

### 1. Host admission gate

- `beginRecovery()` returns an incremented epoch; repeated begins do not open or reset an existing recovery period.
- `waitForSpawnAdmission()` is an optional hook on the Agent process manager, called before `spawn()`.
- `commitRecovery(epoch)` takes effect only for the current epoch and releases waiters.
- `failRecovery(epoch, error)` releases waiters to failure; subsequent requests still need to go through the fail-closed check in `resolveSpawnEnv`.
- The gate holds no workspace/session/task data and does not participate in desktop continuous or web replayable snapshot/queue logic.

### 2. Pending starts and generation fence

- `startingByWorkspaceKey` is a workspace-level single-lane channel; dispose only increments the generation and preserves the in-flight promise until its finally cleanup.
- Start promises check sequentially after command/env resolution and before the actual `spawn()`: manager not disposed, workspace generation not changed, admission gate opened.
- Any check failure must not create a child process, nor write old promises/clients to `processesByWorkspaceKey`.
- New requests after dispose continue to reuse the same promise before the old promise completes, avoiding a second spawn lane; after the old promise exits, the next request creates a new start promise, and the finally can only clean up the map entry by promise identity.

### 3. Recovery close

- `recycleUntilStable` still uses the workspace registry revision as the stability condition; consumers use guarded commit to simultaneously open the gate and submit the Helper marker.
- With the gate closed, new `getClient` calls wait before command/env resolution, so no additional registry revisions are produced; only existing requests that have entered resolve may contribute one additional pass, then submit on the stable revision.
- The registry's duplicate admission semantics are maintained by the producer; this fix does not change the Windows named pipe or the producer package version, avoiding coupling consumer-side recovery fixes with CUA producer releases.
- The producer's `commitRecovery` is currently a `void` callback, and the spawn-env's Healthy⇒clear may clear the marker before the producer reads it in the next cycle. Therefore, the gate cannot wait for "the producer definitely callbacks again" as an open-gate condition, which would form a permanently active deadlock; the current gate is closed on the consumer side via commit/fail paths.
- A stale generation commit may open the gate a short window earlier than the producer's final closure. This window does not deliver old socket/token but may produce additional `BROKER_UNAVAILABLE` Agents; this is a P2 observation item, not a new cross-repo contract introduced in this fix.
- If recovery throws an error, the gate fail-closed, log a warning/error, and rely on the next request and existing UI bounded retry to recover; no background infinite retry should start within the Host.

### 4. Cross-platform and Message Links

- Windows: named pipes lack `.pending` rendezvous and must rely on the Host admission gate to prevent Agents from spawning before the Helper is ready.
- macOS: POSIX rendezvous is retained to reduce cold-start races; the gate serves as a shared recovery barrier, covering the Helper restart/credential rotation window.
- Desktop `desktop-continuous` does not splice web replayable recovery messages; web `web-remote-replayable` continues recovery through snapshot/gap.

## Acceptance and Observability

Cover at least the following regression scenarios:

1. When the gate is closed, concurrent `getClient` can only keep one pending start; after the Helper commits, only one Agent is spawned.
2. Execute `disposeWorkspace` while command/env resolution is pending; the old start after recovery does not spawn; subsequent new requests can successfully spawn.
3. When recovery commit fails, waiters receive an error and do not spawn agents with old credentials.
4. Windows and macOS use the same gate behavior; platform differences are only in the Helper transport/rendezvous layer.
5. Existing desktop continuous and web remote replayable session realtime tests continue to pass.

Production logs should be able to associate the following one-time lifecycle events by workspaceKey/epoch: `recovery_begin`, `spawn_admission_wait`,
`recovery_commit`/`recovery_fail`, `spawn_blocked_by_generation`; commit logs simultaneously record whether the admission was indeed released.
Do not judge stale generations solely by the spawn count between two admission logs; you must combine generation or marker evidence.
Individual stream/chunk items still use debug, to avoid log volume inflation.
