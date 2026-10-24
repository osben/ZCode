# Remote workspace connection ARMS custom-event telemetry

> Status: implemented, awaiting test-environment ARMS acceptance
> Related branch: `fix/add-arms-for-remote`
> Related spec: [Remote scenario usage telemetry V1](./remote-usage-telemetry-v1.md) (data-warehouse `/report` channel; this document supplements it with the ARMS channel and does not replace V1)

## Goals and product questions

This telemetry answers two product questions on ARMS (Alibaba Cloud RUM):

1. **Which desktop devices use remote workspaces** — query `remote_active_session_count` with `custom.value > 0`,
   de-duplicated by `device_mid`. The ARMS `user.name` is already fixed to `device_mid`, so user-dimension lookup
   also works; to split explicit connection usage by remote kind query `remote_connect_result` instead.
2. **How many remote workspace connections each desktop device has open at the same time** — `custom.value` of
   `remote_active_session_count` is the current number of active logical remote workspace sessions. Take the
   per-`device_mid` max over the time range first, then compute the distribution over the device-level max.

Definitions:

- Scope: **remote workspace connections initiated by desktop `ConnectRemote`** (SSH/WSL/Docker/Server); the relay,
  bridge or replayable attachment of mobile Web Remote Control is not counted as a new remote connection.
- The `ConnectRemote` handler must explicitly mark this Main-local route `remoteUsageTelemetryEligible=true`; other
  internal callers default to false. Stats, gauge, disconnect and periodic sampling handle only eligible routes,
  which mechanically guarantees the scope does not widen as the manager gains new callers.
- The primary definition of "simultaneous remote connections" is the **active logical session count**, i.e. the
  number of remote workspaces the user has open at once; it is neither the physical TCP/SSH connection-pool entry
  count nor the number of remote physical devices.
- User definition: **`device_mid` only** (consistent with existing ARMS events; the ARMS SDK masks `user.id`, so the
  account uid cannot be injected into the user field. Account-level analysis keeps using `user_id` of the V1
  warehouse channel).
- Event scope: explicit desktop connection success/failure, active-session gauge, disconnect and observable
  connection duration.

## Relation to the V1 warehouse channel

|                                   | V1 warehouse `/report`            | This document (ARMS)                              |
| --------------------------------- | --------------------------------- | ------------------------------------------------- |
| Explicit desktop connection terminal | `remote_workspace_connect_result` | `remote_connect_result` (same trigger, superset of fields) |
| Disconnect event                  | none (pruned in V1)               | `remote_disconnect`                               |
| Concurrency gauge                 | none (pruned in V1)               | `custom.value` of `remote_active_session_count`   |
| Connection duration               | none (pruned in V1)               | `custom.value` of `remote_disconnect`             |
| User identity                     | `user_id` (when logged in) / `device_mid` | `device_mid` only                         |

The connection-result events of the two channels are **deliberately named differently** so that searching by event
name (alert configuration, reconciliation, full-text search) does not confuse the two field sets. Precedent:
warehouse `message_completion` ↔ ARMS `perf_ui_message_complete`.

`remote_connect_result` describes the terminal state of an explicit desktop connection attempt; the ARMS primary
definition of "uses remote workspaces" is the unified gauge, so that both state changes and periodic samples across
the query time range are covered.

## Architecture and event flow

```text
 Renderer                Main process                                   Window Host (UtilityProcess)
    |                       |                                                  |
    | ConnectRemote IPC     |                                                  |
    |---------------------->| desktopMainIpcRemote.ts ConnectRemote handler    |
    |                       |--- createRemoteWorkspaceSession --------------->| connect
    |                       |    (remoteUsageTelemetryEligible=true)           |
    |                       |<-- RemoteWorkspaceConnected ---------------------|
    |                       | handleConnected                                  |
    |                       |   route into map {                               |
    |                       |     connectedAtMonotonicMs,                       |
    |                       |     connectFinalized=false,                       |
    |                       |     remoteUsageTelemetryEligible=true            |
    |                       |   }                                               |
    |<== ScopedServicePort ==| attachRendererPort                              |
    |-- ready ACK ---------->| confirm                                         |
    |                       |   -> connectFinalized=true                       |
    |                       |   -> read after-state stats                      |
    |                       |   -> [gauge 1] remote_active_session_count      |
    |                       |   -> resolve                                     |
    |                       | before IPC success returns -> [connect 1] remote_connect_result |
    |                       | before IPC failure returns -> [connect 2] remote_connect_result |
    |                       |   failure does not change the active set, no gauge |
    |                       |                                                  |
  == disconnect path (unified active-set retire; no path assembles its own gate) ==
    |                       | wasActive = eligible && attachable                |
    |                       |             && connectFinalized                   |
    |                       | -> mark closed / delete route first              |
    |                       | -> read after-state stats                        |
    |                       | -> if wasActive [gauge 2] remote_active_session_count |
    |                       | -> if wasActive [disconnect] remote_disconnect    |
    |                       |                                                  |
    |                       | connection-closed / disposed / window-closed      |
    |                       | / host-exit / app-shutdown share one retire helper |
    |                       |                                                  |
    |                       | every 5 minutes and active_session_count > 0      |
    |                       |   -> [gauge 3] periodic gauge                    |
    |                       | app shutdown: stop the periodic timer first, then retire all |
    |                       |                                                  |
  all events go through dispatchFinalArmsCustomEvent -> e2eController.record -> armsRum.sendCustom
```

- The remote connection authority stays in the Window Host's `windowRemoteConnectionRegistry`. Main's
  `routesBySessionId` only keeps request/session/attachment routes of existing connections; this design derives
  only a low-frequency telemetry gauge from that existing route table and adds no session/task/stream/queue/
  snapshot business state.
- `remoteUsageTelemetryEligible` is only a telemetry scope flag in Main memory; it never enters `RemoteTarget`, the
  Host descriptor, `workspaceIdentity`, cross-process messages or persisted data; it defaults to false and only the
  `ConnectRemote` handler turns it on explicitly.
- Mobile `/remote` still only attaches to the remote session already existing in the desktop window. Bridge
  attach/detach, mobile reconnect and replayable recovery do not change `routesBySessionId` and therefore not the
  gauge.
- Main owns the final ARMS custom-event dispatch; no reporter or protocol field is added to the Host, CLI, relay or
  Web bundle.
- The 5-minute periodic gauge covers long connections that were established before the query range and have no
  state change within it. During system sleep no historical samples are back-filled; the next timer or state change
  resumes sampling after wake.

## Event definitions

group: `remote_usage`. Common dimensions (`event_name` / `app_version` / `arms_env` / `device_mid` / `platform` /
`renderer_id` / `metric_value`) are injected automatically by `buildFinalArmsCustomEventPayload`; all properties are
`String()`-ified.

The ARMS Custom table has one main numeric measure, `custom.value`. So connection results use it as a count,
disconnect as a duration and the concurrency gauge as the active logical session count; a string property cannot
serve as the numeric measure of a concurrency distribution.

### `remote_connect_result`

Trigger: an explicit `ConnectRemote` IPC reaches a success or failure terminal state (same instrumentation point
as the V1 warehouse event).

| Field             | Value                               | Description                          |
| ----------------- | ----------------------------------- | ------------------------------------ |
| value             | `1`                                 | Count of explicit connection attempts |
| `result`          | `success` / `failure`               | Connection result                    |
| `remote_kind`     | `ssh` / `wsl` / `docker` / `server` | Remote kind                          |
| `connect_trigger` | `new` / `reconnect` / `restore`     | Same definition as V1                |
| `error_category`  | the V1 seven enums; empty on success | Produced by `classifyRemoteUsageError` |

### `remote_active_session_count`

Trigger: after the active route set changes, and for a non-zero periodic sample every 5 minutes.

| Field                 | Value                                                                                                    | Description                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| value                 | `active_session_count`                                                                                   | ARMS `custom.value` numeric measure; active logical session count after the change, may be 0 |
| `sample_reason`       | `state-change` / `periodic`                                                                              | State change or low-frequency fill-in                                                    |
| `transition`          | `connected` / `connection-closed` / `disposed` / `window-closed` / `host-exit` / `app-shutdown` / `none` | periodic uses `none`                                                                     |
| `remote_kind`         | the four kinds / empty string                                                                            | Kind of the route behind the state change; empty for periodic                            |
| `active_target_count` | numeric string                                                                                           | De-duplicated count of redacted remote target identities; a diagnostic dimension only, not the main concurrency metric |

State-change samples use the route's `webContentsId` as `renderer_id`. The telemetry module keeps the latest valid
gauge `rendererId` and periodic samples reuse it; `active_session_count > 0` with no latest rendererId is
unreachable in the state machine, because every active route first produces a state-change sample when finalized.

### `remote_disconnect`

Trigger: a route that had entered the active set leaves it. After-state stats must be read after the route is
removed from the stats source / marked closed; the same route reports only once.

| Field               | Value                                                                             | Description                                                                  |
| ------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| value               | `duration_ms`                                                                     | Observable connection lifetime, monotonic-clock difference clamped >= 0      |
| `remote_kind`       | same as above                                                                     |                                                                              |
| `disconnect_reason` | `connection-closed` / `disposed` / `window-closed` / `host-exit` / `app-shutdown` | see below                                                                    |
| `duration_ms`       | numeric string                                                                    | Same as value, for detail lookup; numeric aggregation uses `custom.value`    |

`disconnect_reason` semantics:

| Value               | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `connection-closed` | Transport-level abnormal disconnect (SSH keepalive half-open, network break, remote process exit) |
| `disposed`          | User-initiated release (closing a tab, cancelling a connected dialog, Host-initiated defensive dispose) |
| `window-closed`     | Closing a window takes all of its connections with it                                 |
| `host-exit`         | Window Host UtilityProcess crash/exit fallback                                        |
| `app-shutdown`      | Normal quit or update install entering the shutdown barrier                           |

Duration definition: `connectedAtMonotonicMs` is recorded when Main receives `RemoteWorkspaceConnected`, using
`performance.now()` by default; a bind context / renderer reload re-attach does not reset the timer. A normal app
shutdown reports best effort; a sudden Main crash, kill -9 or power loss remains a right-censored sample and does
not enter the average duration.

## Concurrency and target definitions

`getRemoteConnectionStats()` (new in `createRemoteWorkspaceSessionManager`) counts only routes with
`remoteUsageTelemetryEligible && attachmentState === "attachable" && connectFinalized`:

- `active_session_count`: the number of routes, i.e. active logical remote workspace sessions. It is the sole main
  definition of "simultaneous remote connections"; two workspaces opened on the same remote target = 2.
- `active_target_count`: the count de-duplicated by the redacted target identity key, a diagnostic attribute only.
  The key lives only in Main memory and is never reported:
  - ssh → `"ssh:" + buildSshRemoteHostKey(target)`
  - wsl → `"wsl:" + (distro?.trim() || "default") + "\0" + (user?.trim() ?? "")`
  - docker → `"docker:" + container`
  - server → `"server:" + normalizeServerRemoteUrlForComparison(url)`
- A server URL is normalized only for the same security level: `ws:// == http://`, `wss:// == https://`;
  `ws:// != https://`.
- The manager is an app-wide singleton, so the gauge aggregates across windows; this does not mean the Host
  physical connection pool is shared across windows.
- The route target already had passwords/tokens stripped by the Host `stripRemoteTargetSecrets`, so SSH password
  auth may appear as `agent` in the Main key. `active_target_count` is therefore neither a physical device count nor
  a physical transport count and is not used for product KPIs.

## State-change and idempotency invariants

All exit paths must reuse one atomic retire helper and not each decide and report directly:

```text
wasActive = route.remoteUsageTelemetryEligible
            && route.attachmentState == attachable
            && route.connectFinalized
    |
    +-> false: idempotent cleanup only, no gauge, no disconnect
    |
    +-> true:
          1. mark closed or delete from routesBySessionId
          2. read after-state stats
          3. send remote_active_session_count
          4. send remote_disconnect
```

This guarantees:

- After `connection-closed` marks a route closed, a later tab dispose does not report again.
- A route whose attach was never confirmed never entered the active set, so it produces no gauge/disconnect; the
  ConnectRemote catch reports the failure.
- An internal route not explicitly marked eligible does not enter stats even when connected, produces no
  gauge/disconnect and does not update the periodic gauge's rendererId.
- Host exit, window close and app shutdown arriving in any order make each active route leave only once.
- A reporter/getStats/sendCustom error cannot roll back route state or block connecting and cleanup.

## Privacy boundary

The V1 forbidden list is inherited (section "Error categories and privacy" of
[remote-usage-telemetry-v1.md](./remote-usage-telemetry-v1.md)): no event may upload `workspacePath` /
`workspaceIdentity` / `remoteSessionId` / SSH host, user name, port / Docker container / WSL distro / Server URL /
raw error message or stack.

Reported fields contain only controlled enums, aggregate counts and durations; no remote identity text is uploaded.
The de-duplication key of `active_target_count` lives only in Main memory and the event carries only the aggregated
numeric string.

## Pruning and known boundaries

- `remote_connect_result` keeps the "explicit desktop connection attempt" meaning; concurrency and actual-use
  device counts are all computed from the gauge.
- Telemetry eligibility defaults false and only the `ConnectRemote` handler turns it on explicitly; later new
  manager callers do not automatically enter this metric's scope.
- renderer reload / bind workspace context / attachment generation change do not change the active route set,
  produce no state-change event and do not reset the duration.
- Cancel during connecting and connect failure produce no disconnect or gauge; `remote_connect_result failure`
  covers them.
- The periodic gauge is fixed at 5 minutes to support day/week windows; ad-hoc queries shorter than 5 minutes with
  no state change in between may need to extend the query range backwards.
- Normal app shutdown reports best effort; a main-process crash, force-kill or power loss cannot back-fill
  disconnect, so the connection-duration metric must be labelled "observable completed samples".
- This feature changes neither desktop `continuous` nor mobile `replayable` chains, adds no conversation/session
  E2E and updates no conversation case catalog/coverage matrix.

## Metric computation examples

| Metric                                     | Computation                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Remote-workspace usage devices (day/week)  | `remote_active_session_count` with `custom.value > 0`, de-duplicated by `device_mid` |
| Devices with a successful explicit connection | `remote_connect_result` with `result=success`, de-duplicated by `device_mid`      |
| Usage devices per explicit connection kind | Same, grouped by `remote_kind`                                                       |
| Per-device peak simultaneous connections   | `max(custom.value)` of `remote_active_session_count` aggregated by `device_mid` first |
| Peak simultaneous connection distribution  | P50/P90/max over the device-level max of the previous step; never a histogram over all event rows |
| Observable average connection duration     | `custom.value` of `remote_disconnect`; the dashboard notes it excludes right-censored samples of sudden main termination |
| Transport abnormal-disconnect share        | `disconnect_reason=connection-closed` / all `remote_disconnect`                      |

## Implementation notes

### State owners and files

| State / fact                                     | Owner                                                     | File                                                                      |
| ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| ARMS payload / configure / periodic gauge / reporting | New module (reuses the final dispatch of `desktopArmsCustomEvent.ts`) | (new) `packages/desktop/src/main/desktopRemoteUsageArmsTelemetry.ts` |
| Explicit connection terminal                     | ConnectRemote IPC handler                                 | `packages/desktop/src/main/desktopMainIpcRemote.ts`                       |
| route lifecycle / atomic retire / concurrency stats | RemoteWorkspaceSessionManager                          | `packages/desktop/src/main/desktopRemoteSessions.ts`                      |
| Wiring and shutdown timer closure                | Main entry                                                | `packages/desktop/src/main/index.ts`                                      |

1. `desktopRemoteUsageArmsTelemetry.ts`: constants `REMOTE_USAGE_ARMS_GROUP = "remote_usage"`, the three event
   names and `REMOTE_USAGE_GAUGE_INTERVAL_MS = 300_000`; types `RemoteDisconnectReason`,
   `RemoteGaugeTransition`, `RemoteConnectionStats { activeSessionCount; activeTargetCount }`; pure builders
   `buildRemoteConnectResultArmsPayload`, `buildRemoteActiveSessionCountArmsPayload` (`value =
   stats.activeSessionCount`), `buildRemoteDisconnectArmsPayload` (`value = durationMs`);
   `configureRemoteUsageArmsTelemetry({ armsCustomContext, getRemoteConnectionStats, sendCustom, e2eController?,
   logger, setInterval?, clearInterval? })` is a module singleton that starts the 5-minute timer and sends a
   periodic gauge only when count > 0 and a latest rendererId exists; `reportRemoteConnectResultToArms` /
   `reportRemoteConnectionStateChangedToArms` / `reportRemoteDisconnectToArms` are no-ops before configure, never
   throw (internal try/catch) and all go through `dispatchFinalArmsCustomEvent`;
   `stopRemoteUsageArmsPeriodicSampling()` stops only the timer and keeps the reporter configuration so app
   shutdown can still send the final gauge/disconnect; `resetRemoteUsageArmsTelemetryForTest()` stops the timer and
   clears module state. It reuses `RemoteUsageRemoteKind` / `RemoteWorkspaceConnectTrigger` /
   `RemoteUsageErrorCategory` / `RemoteUsageResult` from shared and adds no protocol or shared runtime schema.
2. `desktopRemoteSessions.ts`: `PendingConnect` and `RemoteAttachmentRoute` gain
   `remoteUsageTelemetryEligible: boolean`; the route also gains `connectedAtMonotonicMs: number` and
   `connectFinalized: boolean` (top-level on the route so a bindContext descriptor replacement does not lose them).
   `createRemoteWorkspaceSession` gets a fifth Main-local lifecycle parameter
   `{ remoteUsageTelemetryEligible?: boolean }` defaulting to false, written only to pending/route and never
   forwarded to the Host. Options gain optional `reportRemoteConnectionStateChanged`, `reportRemoteDisconnect` and
   `monotonicNowMs` (test injection, default `performance.now`), with type-only imports to avoid a runtime cycle.
   `confirmRendererAttachmentReady` sets `connectFinalized = true` on the first connect before resolve, after which
   only eligible routes report the `transition=connected` after-state gauge; bind/reattach ready ACKs do not
   finalize again. A unified `retireActiveRoute(route, transition, mutate)` captures `wasActive` first
   (`eligible && attachable && connectFinalized`), performs mark/delete, then reads stats, and reports gauge and
   disconnect in turn only for `wasActive`. `handleClosed` / `disposeRemoteWorkspaceSession` /
   `disposeRemoteWorkspaceSessionsForWindow` / `child.once("exit")` / `disposeAllAndWaitForAppShutdown` all reuse
   it. App shutdown uses `app-shutdown`, retiring each route first and clearing afterwards (not a direct
   `routesBySessionId.clear()`). The return object gains `getRemoteConnectionStats()`.
3. `desktopMainIpcRemote.ts`: options gain a required `getRemoteConnectionStats: () => RemoteConnectionStats`; the
   `createRemoteWorkspaceSession` option signature gains the Main-local lifecycle parameter and `ConnectRemote`
   passes `{ remoteUsageTelemetryEligible: true }` explicitly; `configureRemoteUsageArmsTelemetry` is called after
   `finalArmsCustomEventE2E` is created (registration precedes first-window creation, so no connection event can
   precede configure); `ConnectRemote` calls `reportRemoteConnectResultToArms` once before returning success or
   failure, with no concurrency property (concurrency comes only from the canonical gauge); an outer safe try/catch
   keeps any telemetry exception from rewriting a successful connection as a failure.
4. `index.ts`: manager options inject `reportRemoteConnectionStateChangedToArms` and `reportRemoteDisconnectToArms`;
   `registerRemoteIpcHandlers` gets `getRemoteConnectionStats`; `prepareAppQuit` synchronously runs
   `stopRemoteUsageArmsPeriodicSampling()` before `remoteSessionManager.disposeAllAndWaitForAppShutdown`, after
   which the manager sends the `app-shutdown` gauge/disconnect and the ARMS SDK flushes best effort within the
   existing Host shutdown barrier window; the actual arrival rate must be accepted in the test environment.
5. Doc index: `docs/monitoring/README.md` lists this document; `business-monitoring.md` notes that concurrency/
   duration are here where it references V1; the "pruned in this phase" section of `remote-usage-telemetry-v1.md`
   notes that logical-session concurrency and observable duration are carried by the ARMS channel. This document is
   not registered in `performance-telemetry-catalog.md` (a performance event dictionary; usage groups such as
   `plan_usage` / `send_funnel` are not in it either).

### Test plan (tests before implementation)

- **A (new) `packages/desktop/test/desktopRemoteUsageArmsTelemetry.test.ts`:** field sets and `custom.value` of the
  three builders (connect=1, gauge=active sessions, disconnect=duration); failure defaults `errorCategory ->
  unknown`; properties carry no target/path/session identity; before configure nothing is thrown or sent; after
  configure the real `createFinalArmsCustomEventE2EController` asserts common dimensions and suppress; fake timer:
  count=0 sends no periodic, count>0 sends every 5 minutes with the latest rendererId, nothing after stop/reset;
  getStats / sendCustom errors are swallowed with `logger.warn`; every case resets for isolation.
- **B (extend) `packages/desktop/test/desktopRemoteSessions.test.ts`:** stats: two eligible logical sessions on the
  same SSH target -> session=2 / target=1, four kinds mixed de-duplicated; server normalization (`ws:// == http://`,
  `wss:// == https://`, `ws:// != https://`); an unconfirmed attach is not counted and sends no gauge; the first
  ready sends exactly one `connected` gauge, bind/reattach ready does not repeat; an internal connection without the
  lifecycle parameter or with eligible=false stays out of stats and sends no gauge, and neither do its later
  disconnect/app shutdown; connection-closed reports once and a later dispose does not report again; dispose /
  window close / host exit each produce the matching transition + disconnect and every gauge is the after-state;
  app shutdown reports `app-shutdown` per route with the last gauge value=0, and an unconfirmed route is not
  reported; a callback error does not interrupt route cleanup; duration is exact with an injected monotonic clock.
- **C (extend) `packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts`:** configure is called and passes
  through `getRemoteConnectionStats` / E2E controller / sendCustom; parameters for explicit connect success/failure
  and the four remote kinds; `createRemoteWorkspaceSession` receives `remoteUsageTelemetryEligible=true`;
  connect-result carries no concurrency field; an ARMS reporter error does not rewrite a `{ success: true }`
  return.
- **D (regression):** `packages/desktop/test/e2eProcessCleanup.test.ts` covers the index.ts shutdown-barrier wiring;
  full regression of the existing remote session / window lifecycle unit tests. The feature changes no conversation
  state, V4 wire or replayable/continuous boundary and adds no conversation E2E case.

### Required ARMS acceptance (open)

The E2E bridge records the payload before `sendCustom`, which proves only that the client assembled it correctly,
not SDK flush, ARMS ingestion or the query definitions. The following test-environment acceptance is therefore a
pre-release requirement, not an optional smoke:

1. With the E2E bridge double gate on, connect two WSL/Docker remote workspaces, disconnect one, and confirm the
   locally recorded final gauge payload sequence is `1 -> 2 -> 1`.
2. Keep at least one connection across 5 minutes and confirm the periodic gauge is ingested.
3. Quit the App normally and confirm the `app-shutdown` disconnect and the final gauge 0 are queryable in the ARMS
   test environment.
4. In the ARMS Custom table verify: `custom.value` is a number, `user.name` equals `device_mid`, and the per-device
   `max(custom.value)` and the second-stage P50/P90 queries match expectations.
5. Verify no event contains forbidden target/path/identity/raw-error text.

If the current dev machine lacks a real WSL/Docker/SSH environment, the commit message must list the unfinished
items and the ARMS data definitions must not be marked accepted.

### Verification commands (repo root)

```bash
pnpm typecheck
pnpm lint
pnpm exec vitest run \
  packages/desktop/test/desktopRemoteUsageArmsTelemetry.test.ts \
  packages/desktop/test/desktopRemoteSessions.test.ts \
  packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts \
  packages/desktop/test/e2eProcessCleanup.test.ts
```
