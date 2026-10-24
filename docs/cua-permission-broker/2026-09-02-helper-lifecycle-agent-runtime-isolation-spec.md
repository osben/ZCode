# Helper lifecycle must not affect Agent runtime: Specification

## Status

- Status: P0/P1/P2 implemented; scheduled health probes with automatic recovery have been removed.
- Date: 2026-09-02; last update 2026-09-03.
- Scope: Desktop local Host, Computer Use Helper, ZCode Agent runtime, `zcode-cua` MCP broker.
- Related issues: `ZCT-2094300783841067008`, `ZCT-2095050283542110208`.
- Replaces the earlier convention that "Helper ready/recovery must recycle persistent Agent"; the Agent recycle section of [CUA Helper Recovery Admission Gate](./cua-agent-recovery-admission-gate.md) must be consolidated per this spec. The fail-closed, process identity verification and spawn generation fence of the old spec remain.
- Replaced clauses (2026-09-21): §3.1 "2026-09-10 spawn fast path" and the bounded probe entry in §3.3 about "whether Agent spawn env can inject the current broker tuple" are superseded by [CUA Helper Lazy Startup Specification](./2026-09-21-cua-helper-lazy-startup-spec.md): spawn env injection of credentials performs no health check. The remaining clauses stay in effect.

## I. Product invariants

The Computer Use Helper provides CUA capabilities; it is not the lifecycle owner of the Agent runtime. Always:

1. Helper cold start, delayed ready, health probe failure, permission recovery and process restart never actively terminate or restart the Agent.
2. Helper lifecycle events never block startup or recovery of other modules (model providers, MCP, task index, session hydration, conversation subscriptions, normal Agent turns).
3. When the Helper is unavailable only CUA tool availability is reduced; non-CUA conversations, regular MCP and the Agent runtime never enter `workspace-dispose`.
4. Agent restart is determined solely by the Agent crashing, workspace closure, explicit user action or the Agent runtime's own recovery policy.
5. "Helper ready" is not an implicit signal that "Agent must be re-spawned".
6. The Host does not poll Helper health by timer. Health checks occur only at CUA startup, resolution, invocation, permission confirmation and other explicit on-demand boundaries, and a failed check never triggers Agent runtime lifecycle actions.

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

## II. Historical problem (resolved)

Two reverse control chains from Helper to Agent existed; the Agent recycle side effect has been severed:

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

Facts: Agent spawn waited for Helper env resolution in [node.ts](../../packages/services/src/node.ts); `reconcileRecoveredHelper()` historically recycled persistent agents and now only clears the subsequent spawn admission marker ([cuaProductMcpResolver.ts](/Users/dev/zcode-cua/src/broker/server/cuaProductMcpResolver.ts)); `disposeWorkspace()` cleans the Agent via `workspace-dispose` ([zcodeAgentProcessManager.ts](../../packages/services/src/zcode-agent/zcodeAgentProcessManager.ts)); both tickets showed `Helper unreachable -> Helper ready -> Agent SIGTERM(workspace-dispose) -> new Agent`.

Cold-start pre-allocation and recovery recycle are different paths. At cold start the Host can pre-allocate socket/token for the Agent and hand over the transport atomically after the Helper becomes ready, avoiding an Agent restart. The old recycle path was hit when Agent spawn was marked `BROKER_UNAVAILABLE` after the grace period, when the liveness watchdog (every 10 s) called `resolver.restart()`, when a Helper restart generated a fresh socket/token while the old Agent kept old credentials, and when `reconcileRecoveredHelper()` called `disposeWorkspace()` in batch through the workspace registry. Removing a single `disposeWorkspace()` call was therefore insufficient: P0 also removed the Agent side effect from the recovery callback and let normal Helper restart prefer reusing the host transport; P1 provides the long-term stable facade.

## III. Normative behavior

### 3.1 Helper startup

- (Superseded by the lazy startup spec) 2026-09-10 spawn fast path: full startup is handled by the original tracker; when a safe `reservedTransport` already exists and no unavailable marker exists, return immediately instead of waiting 1 s to read the same tuple. Windows still waits for `transport_ready` first; without pre-allocation, warm health failure and background startup failure keep the existing admission rules.
- Helper startup is a detached/background Host operation.
- Generic service initialization, Agent spawn, session resume, task index and regular MCP initialization never wait for the Helper to be fully ready.
- The Host generates and holds the broker transport admission tuple as early as possible; generating it never waits for the Helper native backend, TCC or a complete health probe.
- If the tuple can be pre-allocated safely, the Agent starts with it and the broker client uses bounded, cancellable retries while the Helper is not ready.
- If the tuple is temporarily unavailable the Agent still starts, but CUA tools fail with a retryable `broker_not_ready`; no workspace that would later trigger Agent recycle is registered for that state.

### 3.2 Helper ready

Allowed: publish current Helper readiness, generation, socket/transport availability; clear the Helper's own startup marker; wake waiting CUA tool retries; record a low-frequency lifecycle telemetry event.

Forbidden: calling `disposeWorkspace()`; calling `recycleUntilStable()`; closing or rebuilding the Agent protocol client; triggering session resume as a side effect; triggering any Agent operation for other workspaces.

### 3.3 On-demand health checks and recovery/restart

The default product assembly creates no periodic Helper liveness timer and does not call `resolver.restart()` on a single probe failure during idle periods. Allowed health-check entry points are explicit needs:

- Agent spawn env deciding whether it can inject the current broker tuple (superseded by the lazy startup spec);
- the CUA MCP server resolve/request boundary confirming current Helper availability;
- the user completing permission authorization and needing explicit verify/restart;
- Host startup, shutdown or a Helper process-exit event only reconcile the Host's own state; an exit event does not proactively restart, and the next CUA demand boundary starts/recovers on demand.

Even if the Helper gets stuck while idle, no background timer probes or restarts it; the next CUA on-demand boundary runs a bounded `checkHealth` and on failure only recovers the Helper or returns CUA-only retryable/fail-closed results. Non-CUA modules, the Agent runtime, sessions and task state are not involved.

Recovery splits into two decoupled results:

```text
Helper recovery result
  ├─ readiness: starting | ready | degraded | stopped
  ├─ helperGeneration / processIdentity
  └─ agentInvalidationRequired: false
```

`agentInvalidationRequired` is always `false` under this spec. If the Helper process does exit: the Host reclaims and re-verifies the Helper process identity; the Host broker facade keeps the Agent-side connection contract unchanged; current CUA requests return retryable or `possibly_sent` per delivery-safety rules; new CUA requests retry after the Helper becomes ready; normal Agent turns, session events, task index and other MCPs continue on the original runtime.

### 3.4 Credentials and transport

The implementation must satisfy one of:

1. The Agent sees a stable broker facade socket/token for the Host lifetime, with the Helper only a downstream implementation of the facade;
2. The Agent-side MCP client reconnects in place when the Helper generation changes and obtains current valid credentials through the Host, without restarting the Agent or rebuilding the session.

Not acceptable: only deleting Agent recycle while still generating a brand-new socket/token for each normal Helper restart; letting the Agent keep an old bearer token and expecting the old MCP connection to obtain new credentials automatically; writing the new token into global Agent env, regular MCP env, hooks or Bash subprocess environments.

Credentials keep the original security boundaries: injected only into the official CUA MCP server; Helper process identity, peer, generation and old-process-exit evidence keep undergoing fail-closed verification.

### 3.5 CUA behavior when the Helper is unavailable

```text
CUA tool request
  -> Host facade has current Helper
       ├─ yes: normal call
       └─ no: bounded wait/retry
                ├─ Helper ready: continue current request
                ├─ retryable timeout: return broker_not_ready
                └─ possibly_sent: no automatic replay, handled by existing safety semantics
```

`broker_not_ready` affects only that single CUA tool call and never escalates to `workspace-dispose`, session error or Agent runtime restart. Retries have an absolute deadline and never retry infinitely in the background.

### 3.6 CUA plugin toggle startup gate

Switching CUA from enabled to disabled on the plugin settings page only writes the startup configuration and does not touch the current runtime:

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

This path does not depend on a periodic watchdog, background health probe or Agent restart. The running Agent process, sessions, existing CUA MCP, Helper, regular MCP and non-CUA subprocesses stay unchanged, so existing conversations need to restart ZCode to fully switch. Agent subprocesses can still be reused per workspace, but each newly created or re-materialized session runtime re-reads the plugin gate; new conversations after disabling do not inject CUA MCP nor re-obtain CUA capability just because the Helper stays in the background. The Helper may stay resident until the Host/App lifecycle ends but is not consumed by new sessions.

## IV. Boundaries and state owners

| State/Fact | Authoritative owner | Can Helper modify? | Can Agent be affected? |
| --- | --- | --- | --- |
| Helper process/readiness | Host + Helper lifecycle | Yes | Only CUA tool readiness |
| Broker transport facade | Host | Yes | Agent connection contract unchanged |
| Agent process/runtime | Agent process manager | No | Only the Agent's own lifecycle policy |
| Session messages/active turn | Agent runtime/session store | No | Helper must not clear or rebuild |
| Task index metadata | Host task index syncer | No | Helper ready must not trigger Agent dispose |
| CUA tool retry state | CUA broker client/facade | Yes | Only the current CUA request |
| Desktop realtime | `desktop-continuous` attachment | No | No Helper-specific replay messages |
| Mobile remote realtime | `web-remote-replayable` attachment | No | Snapshot/gap recovery; no independent Helper created |

Workspace isolation uses `workspaceIdentity?.trim() || workspacePath`; Helper recovery must not treat different remote workspaces as the same Agent by bare `workspacePath`.

## V. Implementation phases

- P0 (sever reverse lifecycle control): remove `disposeWorkspace` side effects from the Helper ready, liveness recovery and `reconcileRecoveredHelper` paths; `CuaProductHelperWorkspaceRegistry` is no longer an Agent recycle target set (retained only for readiness observation and telemetry); `resolveSpawnEnv` does not wait for full Helper readiness and consumes the pre-allocated tuple, a stable facade tuple, or immediately returns the CUA-only `broker_not_ready` state; keep the old process identity, generation fence and fail-closed checks.
- P1 (stable broker facade): the Host holds a stable Agent-facing socket/capability with a replaceable downstream Helper connection; Helper generation changes update only the facade's downstream handle; the facade does bounded retry, cancellation propagation and delivery-state classification; a normal Helper restart no longer mints a new Agent-facing tuple.
- P2 (remove the old Agent recycle contract): remove the product semantics of `onHelperCredentialsRotated -> recycleUntilStable -> disposeWorkspace`; restrict the admission gate to Helper self-startup/transport admission, no longer blocking Agent spawn; update old recovery spec, comments, test names and telemetry fields to stop the "recovery must recycle Agent" misdirection.

## VI. Verification matrix

| Case | Initial state | Event | Expected |
| --- | --- | --- | --- |
| HLR-01 | Helper cold-start, normal Agent spawn | Helper delayed ready | Agent starts immediately; PID/runtime generation unchanged |
| HLR-02 | Helper cold-start, pre-allocated tuple published | Helper ready | Agent does not restart; the same CUA MCP connection eventually available |
| HLR-03 | Helper cold-start, tuple temporarily unavailable | CUA tool request | bounded retry or `broker_not_ready`; Agent not recycled |
| HLR-04 | Agent has active CUA turn | Helper health probe failure | Agent not restarted due to Helper; current request handled by safe delivery state |
| HLR-05 | Agent has normal non-CUA turn | Helper recovery | Conversation continues; non-CUA MCP, model provider, task index unaffected |
| HLR-06 | Helper stuck or process exits after idle, no CUA requests | Wait exceeds historical watchdog cycle | No periodic probe/restart or exit-event auto-recovery; Agent PID/session unchanged; next CUA demand recovers on demand |
| HLR-07 | Multiple parallel workspaces | Single Helper recovery | No cross-workspace Agent dispose; workspace identity isolation preserved |
| HLR-08 | Desktop continuous | Helper ready/recovery | No replayable recovery messages injected; continuous cursor unchanged |
| HLR-09 | Mobile remote/replayable | Desktop Helper recovery | Phone recovers through shared-host attachment only; no second Helper/runtime |
| HLR-10 | Helper recovery and Agent spawn concurrent | Generation interleaving | Old tuples not delivered; running agents not disposed due to generation check failure |
| HLR-11 | Helper token/identity verification failure | Recovery completes | CUA fail-closed; Agent and normal modules keep running |
| HLR-12 | User closes workspace / Agent crashes | Non-Helper event | Existing Agent dispose/restart semantics allowed; not attributed to Helper recovery |
| HLR-13 | Helper already unavailable | Next CUA resolve/spawn boundary | One bounded on-demand probe/recovery; no periodic timer started, no Agent recycled |
| HLR-14 | CUA plugin running with active Agent | Settings page submit disable | Only writes startup configuration; existing CUA MCP/Helper not closed, Agent not restarted; existing conversations keep capabilities, new conversations do not inject CUA MCP; prompt that existing conversations need to restart ZCode |

Must assert: Helper lifecycle logs contain no `workspace-dispose` directly caused by readiness/recovery; the same Agent's `runtimeIdentity`, session event sequence and active turn do not change due to Helper ready; CUA request failures carry retryable/delivery-state facts, not disguised as Agent crash; non-CUA module startup time does not include the full Helper health budget; desktop and mobile delivery profiles do not propagate to each other.

## VII. Observability and fault attribution

Low-frequency lifecycle fields added or retained: `helperGeneration`, `helperProcessIdentity`, `readiness`; `agentRuntimeIdentity` (association only, never control); `recoveryCause`: `cold-start`, `health-degraded`, `process-exit`, `permission-refresh`; `agentInvalidationRequired` (must be `false`); CUA request `retryable`, `request_delivery_state`, `possibly_sent`.

Immediately classified as regressions: Agent `SIGTERM`, `workspace-dispose` or a new runtime generation after Helper ready/recovery; session resume triggered solely by Helper ready; normal Agent spawn waiting for full Helper startup; Helper token entering global Agent env or non-CUA subprocesses.

## VIII. Sequence for changes to this spec

1. Add/update service and producer resolver contract tests locking "Helper events must not dispose Agent".
2. Implement P0, confirming Agent startup/recovery and CUA readiness are decoupled.
3. Implement the P1 stable broker facade; when broker protocols are involved update producer and shared types/runtime validation together.
4. Remove the old recycle semantics and update the conversation/CUA E2E case catalog and coverage matrix.
5. Run `pnpm typecheck`, `pnpm lint`, affected unit tests and desktop CUA E2E; platforms that cannot be physically verified list risks and pending evidence in the MR.

"Extending Helper wait time" is not an acceptable final solution: wait time can only soften cold-start perception, not fix the wrong ownership between Helper and Agent runtime.

## IX. Implementation status

- P0 implemented: `reconcileRecoveredHelper` and normal Helper recovery no longer call the Agent recycle callback; Desktop recovery admission no longer closes and no longer rebuilds Agents via `disposeWorkspace`.
- macOS product Host normal recovery prefers reusing the verified transport: the Helper process can restart while the existing Agent keeps the same socket/token.
- Windows recovery also reuses the existing named pipe/token; the Helper process can be replaced while the Agent's host-facing transport stays unchanged. A cold/fresh fallback without a verified handle only affects subsequent spawn admission and triggers no Agent recycle.
- P1 stable facade implemented as a Host-owned facade: macOS/Windows Host reuse the same Agent-facing socket/token during normal recovery with the Helper as a replaceable downstream; the broker client handles brief Helper exits through existing bounded warmup retry and delivery-state processing, with no new long-lived process.
- P2 closed: default services assembly no longer injects `CuaAgentAdmissionGate`; `recycleUntilStable` and `onHelperCredentialsRotated` are removed; the `CuaAgentAdmissionGate` type remains as a compatibility export but no longer participates in default Agent spawn.
- Default services assembly no longer starts `startCuaHelperLivenessWatchdog`, so no path auto-calls `resolver.restart()` after a 10-second probe failure; bounded `checkHealth` in spawn env and the Producer resolver remains as on-demand checks.
- The CUA plugin toggle is aligned with BUA as a startup gate: explicit disabling only writes configuration and does not handle the running Agent, existing CUA MCP or Helper; on new Host/Agent/App startup, reading disabled injects no CUA MCP and starts no Helper. The settings page must prompt that existing conversations need to restart ZCode.

### Todo103 supplement: explicit stop and late transport messages

The Windows Host is the sole owner of the transport tuple. An abnormal exit can retain the tuple for on-demand recovery; an explicit stop clears it. When a stop has begun but the old subprocess has not exited, a late ready/transport_ready must not republish an invalidated tuple; the next cold start generates a new tuple.

```text
explicit stop -> invalidate current generation, clear tuple -> wait for old process to exit -> new generation
                     |
                     `-> old ready/transport_ready: ignore, do not publish tuple or health handle
```

This adds no Agent lifecycle or synchronization mechanism; it only complements the source-added tuple cache with the existing stop epoch boundary.
