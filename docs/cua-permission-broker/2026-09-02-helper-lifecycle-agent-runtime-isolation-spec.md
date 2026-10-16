# Helper lifecycle must not affect Agent runtime — Specification

## Status

- Status: P0/P1/P2 implemented; scheduled health probes with automatic recovery have been removed
- Date: 2026-09-02
- Last update: 2026-09-03
- Scope: Desktop local Host, Computer Use Helper, ZCode Agent runtime, `zcode-cua` MCP broker
- Related issues: `ZCT-2094300783841067008`, `ZCT-2095050283542110208`
- Replacement relationship: Once confirmed, this specification replaces the prior convention that "Helper ready/recovery must recycle persistent Agent"; the Agent recycle section of
  [CUA Helper Recovery Admission Gate](./cua-agent-recovery-admission-gate.md) must be consolidated per this specification. The fail-closed, process identity verification, and spawn generation fence from the old spec remain in place.
- Replaced clauses (2026-09-21): Clause §3.1 "2026-09-10 spawn fast path" and the bounded probe entry in §3.3 regarding "whether Agent spawn env can inject the current broker tuple" have been superseded by
  [CUA Helper Lazy Startup Specification](./2026-09-21-cua-helper-lazy-startup-spec.md) — spawn env injection of credentials no longer performs any health check; the remaining clauses of this specification remain in effect.

## I. Product Invariants

The Computer Use Helper is the provider of CUA capabilities, not the lifecycle owner of the Agent runtime.

The following must always hold:

1. Helper cold start, delayed ready, health probe failure, permission recovery, and process restart must never actively terminate or restart the Agent.
2. Helper lifecycle events must not block the startup or recovery of other modules, including model providers, MCP, task index, session hydration, conversation subscriptions, and normal Agent turns.
3. When the Helper is unavailable, only CUA tool availability is reduced; non-CUA conversations, regular MCP, or Agent runtime must not enter `workspace-dispose`.
4. Agent restart is determined solely by the Agent itself crashing, workspace closure, explicit user action, or the Agent runtime's own recovery policy.
5. "Helper ready" is not an implicit signal that "Agent must be re-spawned."
6. The Host must not poll Helper health via timer; health checks must occur only at CUA startup, resolution, invocation, permission confirmation, and other explicit on-demand boundaries, and check failures must not trigger Agent runtime lifecycle actions.

Target state:

```text
Helper lifecycle:  STARTING -> READY -> DEGRADED -> READY/STOPPED
                         |         |          |
                         |         |          +--> CUA tool retryable error
                         |         +-------------> CUA tool available
                         +------------------------> CUA tool waits/retries

Agent lifecycle:   STARTING -> RUNNING ------------------------------> STOPPED
                                  ^                                     ^
                                  |                                     |
                 Helper events --+-- never call disposeWorkspace ------+
```

## II. Current Problems and Evidence

Historical implementations contained two reverse control chains from Helper to Agent (the P0 Agent recycle side effect has now been severed):

```text
resolveSpawnEnv
  -> buildCuaProductHelperAgentEnv
  -> start/checkHealth Helper
  -> may wait or return BROKER_UNAVAILABLE

Helper periodic liveness/recovery (historical path, now removed)
  -> resolver.restart() / reconcileRecoveredHelper()
  -> recycleUntilStable()
  -> disposeWorkspace()
  -> cleanupManagedProcessWithRetry("workspace-dispose")
  -> Agent SIGTERM + new Agent spawn
```

Relevant facts:

- The Agent spawn phase waits for Helper env resolution in [node.ts](../../packages/services/src/node.ts);
- `reconcileRecoveredHelper()` historically performed persistent-agent recycle; currently it only clears the subsequent spawn admission marker, see
  [cuaProductMcpResolver.ts](/Users/dev/zcode-cua/src/broker/server/cuaProductMcpResolver.ts);
- `disposeWorkspace()` ultimately cleans up the Agent via `workspace-dispose`, see
  [zcodeAgentProcessManager.ts](../../packages/services/src/zcode-agent/zcodeAgentProcessManager.ts);
- Both tickets exhibited `Helper unreachable -> Helper ready -> Agent SIGTERM(workspace-dispose) -> new Agent`.

### Cold-start pre-allocation and recovery recycle are not the same path

During cold start, the Host can pre-allocate socket/token first, and the Agent uses the pre-allocated tuple; after the Helper becomes ready, the transport is handed over atomically. The design goal of this path is to avoid restarting the Agent.

However, the following situations fall into the old recycle path:

- Agent spawn marked as `BROKER_UNAVAILABLE` after exceeding the grace period;
- Helper liveness watchdog probes every 10 seconds and directly calls `resolver.restart()`;
- Helper restart generates a fresh socket/token, but the old Agent still holds old credentials;
- `reconcileRecoveredHelper()` calls `disposeWorkspace()` in batch via the workspace registry.

Therefore, simply removing one `disposeWorkspace()` call is insufficient: P0 simultaneously removed the Agent side effect from the recovery callback, and let normal Helper restart prefer reusing the host transport; subsequent P1 continues to solve fully non-blocking Agent spawn and long-term stable facade.

## III. Normative Behavior

### 3.1 Helper startup

- 2026-09-10 spawn fast path: full startup continues to be handled by the original tracker; when a safe `reservedTransport` already exists and there is no unavailable marker, return immediately instead of waiting 1s to read the same tuple. Windows still waits for `transport_ready` first; without pre-allocation, warm health failure and background startup failure preserve the existing admission rules.
- Helper startup must be a detached/background operation internal to the Host.
- Generic service initialization, Agent spawn, session resume, task index, and regular MCP initialization must not wait for the Helper to be fully ready.
- The Host should generate and hold the broker transport admission tuple as early as possible; generating the tuple itself must not wait for the Helper native backend, TCC, or complete health probe.
- If the tuple can be safely pre-allocated, the Agent can start with that tuple; the broker client uses bounded, cancellable retries while the Helper is not yet ready.
- If the tuple is temporarily unavailable, the Agent can still start, but CUA tools must fail with a retryable `broker_not_ready`; no workspace that would later trigger Agent recycle should be registered for that state.

### 3.2 Helper ready

Helper ready is only permitted to perform the following actions:

- Publish current Helper readiness, generation, socket/transport availability;
- Clear the Helper's own startup marker;
- Wake waiting CUA tool retries;
- Record a low-frequency lifecycle telemetry event.

Helper ready is forbidden to:

- Call `disposeWorkspace()`;
- Call `recycleUntilStable()`;
- Close or rebuild the Agent protocol client;
- Trigger session resume as a side effect of Helper ready;
- Trigger any Agent operation for other workspaces.

### 3.3 On-demand health checks and Helper recovery/restart

The default product assembly must not create a periodic Helper liveness timer, nor automatically call `resolver.restart()` due to a single probe failure during idle periods. Allowed health check entry points must be triggered by explicit needs:

- Agent spawn env needs to decide whether it can inject the current broker tuple;
- CUA MCP server resolve/request boundary needs to confirm current Helper availability;
- User completes permission authorization and needs explicit verify/restart;
- Host startup, shutdown, or receiving a Helper process-exit event only reconciles its own state; it does not proactively restart on exit events — the next CUA demand boundary will start/recover on demand.

Therefore, even if the Helper becomes stuck during idle periods, no background timer will proactively probe or restart it; the next CUA on-demand boundary will execute a bounded `checkHealth`, and on failure only recover the Helper or return CUA-only retryable/fail-closed results. Non-CUA modules, Agent runtime, sessions, and task state are not involved in this recovery.

Helper recovery must split into two decoupled results:

```text
Helper recovery result
  ├─ readiness: starting | ready | degraded | stopped
  ├─ helperGeneration / processIdentity
  └─ agentInvalidationRequired: false
```

Under this specification, `agentInvalidationRequired` is always `false`. Helper recovery must not implicitly trigger Agent restart.

If the Helper process does exit:

- The Host is responsible for reclaiming and re-verifying the Helper process identity;
- The Host broker facade maintains the Agent-side connection contract unchanged;
- Current CUA requests return retryable or `possibly_sent` per delivery-safety rules;
- New CUA requests retry after the Helper becomes ready;
- Normal Agent turns, session events, task index, and other MCPs continue using the original runtime.

### 3.4 Credentials and transport

The final implementation must satisfy either of the following equivalent conditions:

1. The Agent sees a stable broker facade socket/token for the Host lifetime, with the Helper being only a downstream implementation of the facade;
2. The Agent-side MCP client supports in-place reconnection when the Helper generation changes, and obtains current valid credentials through the Host, without restarting the Agent or rebuilding the session.

Schemes that cannot be used:

- Only deleting Agent recycle, but still generating a brand-new socket/token for each normal Helper restart;
- Letting the Agent continue to hold an old bearer token, then expecting the old MCP connection to automatically obtain new credentials;
- Writing the new token into global Agent env, regular MCP env, hooks, or Bash subprocess environments.

Credentials must still maintain the original security boundaries: only injected into the official CUA MCP server; Helper process identity, peer, generation, and old-process-exit evidence must continue to undergo fail-closed verification.

### 3.5 CUA behavior when Helper is unavailable

CUA tool calls are handled in the following order:

```text
CUA tool request
  -> Host facade has current Helper
       ├─ yes: normal call
       └─ no: bounded wait/retry
                ├─ Helper ready: continue current request
                ├─ retryable timeout: return broker_not_ready
                └─ possibly_sent: no automatic replay, handled by existing safety semantics
```

`broker_not_ready` affects only that single CUA tool call and must not escalate to `workspace-dispose`, session error, or Agent runtime restart. Retries must have an absolute deadline and must not retry infinitely in the background within the Host.

### 3.6 CUA plugin toggle startup gate

When the plugin settings page switches CUA from enabled to disabled and completes the configuration submission, the submission only writes to the startup configuration and does not touch the current runtime:

```text
plugin disable committed
  -> persist plugin enabled=false
  -> show "Existing conversations need to restart ZCode for changes to take effect"
  -> leave existing Agent/MCP/Helper untouched

next session create/resume (including the same workspace Agent process)
  -> read plugin enabled=false
  -> do not inject CUA MCP
  -> do not start or consume Helper
```

This path must not depend on periodic watchdog, background health probe, or Agent restart. The running Agent process, sessions, existing CUA MCP, Helper, regular MCP, and non-CUA subprocesses remain unchanged; therefore, after the setting is disabled, existing conversations need to restart ZCode to fully switch to the new startup configuration. Agent subprocesses can continue to be reused by workspace, but each newly created or re-materialized session runtime must re-read the plugin gate; new conversations after disabling must not inject CUA MCP, nor re-obtain CUA capabilities just because the Helper remains in the background. The Helper can continue to reside until the Host/App lifecycle ends, but is not consumed by new sessions.

## IV. Boundaries and State Owners

| State/Fact                   | Authoritative Owner                | Can Helper Modify? | Can Agent Be Affected?                                             |
| ---------------------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------ |
| Helper process/readiness     | Host + Helper lifecycle            | Yes                | Only affects CUA tool readiness                                    |
| Broker transport facade      | Host                               | Yes                | Agent connection contract remains unchanged                        |
| Agent process/runtime        | Agent process manager              | No                 | Only the Agent's own lifecycle policy can modify                   |
| Session messages/active turn | Agent runtime/session store        | No                 | Helper must not clear or rebuild                                   |
| Task index metadata          | Host task index syncer             | No                 | Helper ready must not trigger Agent dispose                        |
| CUA tool retry state         | CUA broker client/facade           | Yes                | Affects only the current CUA request                               |
| Desktop realtime             | `desktop-continuous` attachment    | No                 | Does not insert Helper-specific replay messages                    |
| Mobile remote realtime       | `web-remote-replayable` attachment | No                 | Continues via snapshot/gap recovery, no independent Helper created |

Workspace isolation continues to use `workspaceIdentity?.trim() || workspacePath`; Helper recovery must not treat different remote workspaces as the same Agent using bare `workspacePath`.

## V. Implementation Phases

### P0: Sever reverse lifecycle control (stanch the bleeding)

- Remove `disposeWorkspace` side effects from the Helper ready, liveness recovery, and `reconcileRecoveredHelper` paths.
- `CuaProductHelperWorkspaceRegistry` is no longer an Agent recycle target set; if temporarily retained, only used for readiness observation and telemetry.
- `resolveSpawnEnv` does not wait for full Helper readiness; instead consumes pre-allocated tuple, stable facade tuple, or immediately returns CUA-only `broker_not_ready` state.
- Retain the old process identity, generation fence, and fail-closed checks to avoid releasing old tokens under the guise of "decoupling."

### P1: Establish a stable broker facade

- The Host holds a stable Agent-facing socket/capability; the Helper connection is replaceable downstream.
- Helper process generation changes only update the facade's downstream handle.
- The facade executes bounded retry, cancellation propagation, and delivery-state classification for CUA requests.
- Normal Helper restart no longer mints a new Agent-facing tuple that requires Agent respawn to consume.

### P2: Remove the old Agent recycle contract

- Remove the product semantics of `onHelperCredentialsRotated -> recycleUntilStable -> disposeWorkspace`.
- Restrict the admission gate to Helper self-startup/transport admission, and no longer block Agent spawn.
- Update old recovery spec, comments, test names, and telemetry fields to avoid "recovery must recycle Agent" misleading documentation continuing to influence implementations.

## VI. Verification Matrix

| Case   | Initial State                                                         | Event                                  | Expected Result                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HLR-01 | Helper cold-start, normal Agent spawn                                 | Helper delayed ready                   | Agent starts immediately; PID/runtime generation unchanged                                                                                                                                                                                                                           |
| HLR-02 | Helper cold-start, pre-allocated tuple already published              | Helper ready                           | Agent does not restart; the same CUA MCP connection eventually available                                                                                                                                                                                                             |
| HLR-03 | Helper cold-start, tuple temporarily unavailable                      | CUA tool request                       | bounded retry or `broker_not_ready`; Agent not recycled                                                                                                                                                                                                                              |
| HLR-04 | Agent has active CUA turn                                             | Helper health probe failure            | Do not restart Agent due to Helper; current request handled by safe delivery state                                                                                                                                                                                                   |
| HLR-05 | Agent has normal non-CUA turn                                         | Helper recovery                        | Conversation continues; non-CUA MCP, model provider, task index unaffected                                                                                                                                                                                                           |
| HLR-06 | Helper stuck or process exits after idle period, with no CUA requests | Wait exceeds historical watchdog cycle | No periodic probe/restart or exit-event auto-recovery occurs; Agent PID/session unchanged, next CUA demand recovers on demand                                                                                                                                                        |
| HLR-07 | Multiple parallel workspaces                                          | Single Helper recovery                 | No cross-workspace Agent dispose; workspace identity isolation preserved                                                                                                                                                                                                             |
| HLR-08 | Desktop continuous                                                    | Helper ready/recovery                  | No replayable recovery messages injected, continuous cursor unchanged                                                                                                                                                                                                                |
| HLR-09 | Mobile remote/replayable                                              | Desktop Helper recovery                | Phone recovers through shared-host attachment only, no second Helper/runtime created                                                                                                                                                                                                 |
| HLR-10 | Helper recovery and Agent spawn concurrent                            | Generation interleaving                | Old tuples not delivered; agents already running not disposed due to generation check failure                                                                                                                                                                                        |
| HLR-11 | Helper token/identity verification failure                            | Recovery completes                     | CUA fail-closed; Agent and normal modules continue running                                                                                                                                                                                                                           |
| HLR-12 | User closes workspace / Agent itself crashes                          | Non-Helper event                       | Existing Agent dispose/restart semantics allowed; not attributed to Helper recovery                                                                                                                                                                                                  |
| HLR-13 | Helper already unavailable                                            | Next CUA resolve/spawn boundary        | Execute one bounded on-demand probe/recovery; no periodic timer started, no Agent recycled                                                                                                                                                                                           |
| HLR-14 | CUA plugin running with active Agent                                  | Settings page submit disable           | Only writes startup configuration; does not close existing CUA MCP/Helper, does not restart Agent; existing conversations retain original capabilities, new conversations do not inject CUA MCP; prompt that existing conversations need to restart ZCode for changes to take effect |

Must assert:

- Helper lifecycle logs must not contain `workspace-dispose` directly caused by readiness/recovery;
- The same Agent's `runtimeIdentity`, session event sequence, and active turn must not change due to Helper ready;
- CUA request failures must carry retryable/delivery-state facts, not disguised as Agent crash;
- Non-CUA module startup time must not include the full Helper health budget;
- Delivery profiles for desktop and mobile must not propagate to each other.

## VII. Observability and Fault Attribution

The following low-frequency lifecycle fields are added or retained:

- `helperGeneration`, `helperProcessIdentity`, `readiness`;
- `agentRuntimeIdentity` (for association only, not as a control right for Helper);
- `recoveryCause`: `cold-start`, `health-degraded`, `process-exit`, `permission-refresh`;
- `agentInvalidationRequired`: must be `false` under this specification;
- CUA request `retryable`, `request_delivery_state`, `possibly_sent`.

The following phenomena are immediately classified as regressions:

- Agent `SIGTERM`, `workspace-dispose`, or new runtime generation after Helper ready/recovery;
- Session resume triggered solely by Helper ready;
- Normal Agent spawn waiting for full Helper startup;
- Helper token entering global Agent env or non-CUA subprocesses.

## VIII. Implementation Sequence After Spec Changes

1. First add/update service and producer resolver contract tests to lock "Helper events must not dispose Agent."
2. Then implement P0, confirming Agent startup/recovery and CUA readiness are decoupled.
3. Then implement P1 stable broker facade; when involving broker protocols, simultaneously update producer and shared types/runtime validation.
4. Finally remove the old recycle semantics, and update the conversation/CUA E2E case catalog and coverage matrix.
5. Run `pnpm typecheck`, `pnpm lint`, affected unit tests, and desktop CUA E2E afterward; platforms unable to verify physically must list risks and pending evidence in the MR.

This specification does not allow "extending Helper wait time" as the final solution. Wait time can only soften the cold-start perception; it cannot change the incorrect ownership between Helper and Agent runtime.

## IX. Implementation Status

### Todo103 Integration Supplement: Explicit Stop and Late transport Messages

The Windows Host is the sole owner of the transport tuple. An abnormal exit can retain the tuple for on-demand recovery; an explicit stop clears it. When a stop has begun but the old subprocess has not yet exited, a late ready/transport_ready must not republish an invalidated tuple — the next cold start must generate a new tuple.

```text
explicit stop -> invalidate current generation, clear tuple -> wait for old process to exit -> new generation
                     |
                     `-> old ready/transport_ready: ignore, do not publish tuple or health handle
```

This does not add Agent lifecycle or synchronization mechanisms, only complements the source-added tuple cache combined with the existing stop epoch boundary.

- P0 implemented: `reconcileRecoveredHelper` and normal Helper recovery no longer call Agent recycle callback; Desktop recovery admission no longer closes and no longer rebuilds Agents via `disposeWorkspace`.
- macOS product Host normal recovery prefers reusing verified transport; therefore, the Helper process can restart, while the existing Agent continues using the same socket/token.
- Windows recovery now also reuses existing named pipe/token; the Helper process can be replaced, while the existing Agent's host-facing transport remains unchanged. Cold/fresh fallback without a verified handle only affects subsequent spawn admission, and does not trigger Agent recycle.
- P1 stable facade implemented as "Host-owned facade": macOS/Windows Host reuses the same Agent-facing socket/token during normal recovery, with the Helper process only as a replaceable downstream; the broker client continues to handle brief Helper exits through existing bounded warmup retry and delivery-state processing, without needing a new independent long-lived process.
- P2 closed: default services assembly no longer injects `CuaAgentAdmissionGate`; `recycleUntilStable` and `onHelperCredentialsRotated` have been removed; `CuaAgentAdmissionGate` type is retained as a compatibility export but no longer participates in default Agent spawn.
- Default services assembly no longer starts `startCuaHelperLivenessWatchdog`; therefore, no path exists for automatic `resolver.restart()` after a 10-second probe failure; bounded `checkHealth` in spawn env and the Producer resolver remains as on-demand checks.
- CUA plugin toggle aligned with BUA as a startup gate: explicit disabling only writes configuration, does not handle running Agent, existing CUA MCP, or Helper; on new Host/Agent/App startup, reading disabled does not inject CUA MCP or start the Helper. The settings page must prompt that existing conversations need to restart ZCode for changes to take effect.
