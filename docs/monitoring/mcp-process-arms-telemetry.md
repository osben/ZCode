# MCP process ARMS observability

## Status

- Scope: the MCP connection pool / stdio transport inside the Agent, ZCode Protocol dynamic notifications, Host
  forwarding and Desktop main ARMS reporting.
- Change layer: `commit-effect` (new low-frequency, side-channel runtime observation).
- Does not change MCP connections, tool calls, session recycling, desktop continuous or mobile replayable
  delivery semantics.

## Goal

Three lifecycle ARMS events are kept; resource events are covered in the migration note below:

| Event                      | Trigger                                              | Question answered                                   |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `perf_mcp_process_start`   | A formal stdio MCP finished connecting and `tools/list` | How many times each MCP started successfully; the crash-rate denominator |
| `perf_mcp_process_crash`   | A connected stdio MCP exited unexpectedly            | Which MCP crashed, exit traits and run time         |
| `perf_mcp_session_startup` | A session's first MCP startup snapshot closed        | Per-session configured, connected, process and failed counts |

HTTP/SSE MCPs have no local OS child process and send no process start/crash or resource samples, but they enter
`perf_mcp_session_startup.configured_count/connected_count/failed_count`.

## Safe identifiers

- `mcp_source` by runtime distribution channel, three classes: built-in host MCPs and MCPs declared by the ZCode
  Official Marketplace (`zcode-plugins-official`, including Builtin Plugin and CDN Plugin) are uniformly
  `builtin`; MCPs declared by a Personal Source / Inline Plugin are `plugin`; ordinary user/project MCP configs are
  `custom`. The Plugin runtime namespace only expresses the tool namespace and the distribution channel must not be
  inferred from `plugin:<pluginName>:<serverName>`; the Plugin loader must attach runtime-only provenance after the
  public config validation, and the public config schema does not accept that field.
- `mcp_id`: stable for the same MCP within the current installation. Built-in `node_repl` uses the public ID
  `builtin:node_repl`; ZCode Official Marketplace Plugins use the public manifest identity
  `builtin:<pluginName>:<serverKey>`; Personal Source Plugins and user-configured MCPs keep the device-salted HMAC
  `plugin:<digest>` / `custom:<digest>`. Each `:` segment of a public ID keeps only `[A-Za-z0-9._~-]` and other
  UTF-8 bytes are encoded as uppercase `%HH`, so it is readable, reversible and never sends control characters to
  ARMS.
- `mcp_instance_id`: a random ID generated at each successful formal stdio connection; a reconnect produces a new
  one.
- Except for the public `<pluginName>:<serverKey>` identity of the ZCode official marketplace, ARMS never receives
  the raw server name; command, args, cwd, workspace identity/path, env, header, stderr and PID are always
  forbidden.
- Local structured logs record `mcp_id`, `mcp_instance_id` together with the original server name / PID for
  reverse lookup.

## Event contract

### `perf_mcp_process_start`

- `group=stability`, `value=1`.
- Fields: `mcp_id`, `mcp_instance_id`, `mcp_source`, `mcp_isolation`, `runtime_surface`, `platform`, `arch`.
- Sent once, only after the final session transport has connected and completed `tools/list`. A version-negotiation
  probe does not send it.

### `perf_mcp_process_crash`

- `group=stability`, `value=1`.
- Fields: the start identifiers plus `exit_code`, `signal`, `uptime_ms`, `affected_session_count`.
- Sent once, only for a stdio instance that already sent start. Deliberate disconnect, session close, idle recycle
  and app quit/update are not crashes.
- MCP process crash rate:

  ```text
  distinct crash.mcp_instance_id / distinct start.mcp_instance_id
  ```

### `perf_mcp_session_startup`

- `group=stability`, `value=process_count`.
- At most once per session lease with a `session_id`.
- Fields: `session_id`, `configured_count`, `connected_count`, `process_count`, `failed_count`, `runtime_surface`.
  `failed_count` is the number not connected at the first snapshot, including non-connected states such as
  `failed` / `connecting` / `untrusted`, so `configured_count = connected_count + failed_count` always holds.
- `process_count` is the number of connected stdio MCP connections the session holds at that time. A
  workspace-shared MCP counts 1 in every session using it; the shared process is not forcibly attributed to the
  first session.

### Resource event migration (08)

MCP CPU / memory sampling is covered by `perf_process_window` (`process_role=mcp`), see
[all-process CPU / memory telemetry](./process-resource-telemetry.md); the old events stopped being sent from
v3.12.1. The orphan definition below is kept only as an internal tracker fact and adds no ARMS resource
attribute; the old CLI `memory` notification is dropped in main.

## Suspected orphan definition

```text
pool owner count == 0
AND continuous time without an owner > 60 seconds
AND OS resource sampling can still observe the process
=> orphan_suspected = true
```

- The threshold is strictly "more than 60 seconds"; exactly 60 s is still false.
- The pool's existing 30 s idle grace is the normal recycle window and is not marked.
- Non-session leases such as `protocol-settings` are still owners; `owner_session_count=0` alone must not make an
  orphan.
- The first version only finds suspected orphans still known to a live CLI tracker. OS orphans fully detached from
  the tracker after a CLI crash need a Desktop/Host system scan, which is out of scope.

## Data flow and multi-end boundary

```text
MCP adapter / pool
  -> process-scoped McpTelemetryTracker
  -> process/mcpTelemetry strict notification
  -> ZCodeAgentService dynamic event
  -> trusted Desktop Host relay
  -> Host parentPort strict response
  -> Desktop main ARMS sendCustom

mobile / renderer conversation attachment ---------------- X
task snapshot / queue / replay / owner command ------------ X
```

- Local and remote CLIs both sample on the machine that really executes; Desktop main only does the final ARMS
  submission.
- Mobile `/remote` reuses the existing Host/CLI and never subscribes to, caches or replays MCP telemetry.
- Any sampling, schema, RPC, parentPort or `sendCustom` failure only drops the current event and never blocks the
  MCP/session/Agent lifecycle.

## Feature impact brief

| Field            | Value                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Developer intent | Report MCP process start, crash and per-session counts; the resource contract is kept by the all-process spec |
| Capability       | `capability.data-observability` + MCP runtime                                                 |
| Change layer     | `commit-effect`                                                                               |
| Operating mode   | implemented                                                                                   |
| Primary seeds    | MCP adapter/pool, Protocol notification, Agent service, Host parentPort, Desktop ARMS         |
| Out of scope     | UI, MCP connection semantics, tool calls, persistence, global scan for real OS orphans        |

Only UI-surface row: online MCP observability has no UI entry; shared implementation is CLI tracker -> Host ->
main; defaults are 5 min / 60 s constants; strict schemas; commit action ARMS `sendCustom`; authority is the live
process/pool with no persistence; local/remote, desktop reporter only; isolated from UI, conversation stream and
mobile replay.

### Feature relationships

| Rank           | From                | Semantic edge                  | To                    | Condition      | Why inspect it               |
| -------------- | ------------------- | ------------------------------ | --------------------- | -------------- | ---------------------------- |
| must-inspect   | MCP adapter         | emits lifecycle/resource facts | process tracker       | stdio          | PID/exit/memory authority    |
| must-inspect   | MCP pool            | emits ownership/session counts | process tracker       | all leases     | sharing/orphan authority     |
| must-inspect   | CLI notification    | forwards strict facts          | Desktop main          | local/remote   | ARMS owner boundary          |
| invariant-only | MCP telemetry       | must remain separate from      | conversation delivery | desktop/mobile | no replay/snapshot pollution |
| evidence-only  | MCP/telemetry tests | covers                         | event contract        | all            | behavior proof               |

### State owners and commit sinks

| State/fact           | Authoritative owner       | Commit command/service | Persistence/cache   |
| -------------------- | ------------------------- | ---------------------- | ------------------- |
| MCP process instance | stdio transport + tracker | lifecycle event        | process memory only |
| session owners       | connection pool refs      | tracker owner update   | process memory only |
| ARMS payload         | Desktop main reporter     | `sendCustom`           | ARMS backend        |

None of these has a draft/display owner.

### Must-preserve invariants

1. Sampling and reporting failures never affect MCP/session/Agent.
2. Deliberate recycling is not a crash; a probe counts as neither start nor crash.
3. No raw MCP name, command, path, credential, stderr or PID is uploaded.
4. A workspace-shared process is counted by owner lease; no single session owner is fabricated.
5. Desktop main/relay hold no MCP business state; mobile does not report again.
6. Builtin/CDN Plugin MCPs of the ZCode Official Marketplace and the host `node_repl` all aggregate as
   `mcp_source=builtin`; Personal Source / Inline Plugin MCPs keep aggregating as `plugin`; the shared `plugin:`
   runtime namespace must not blur the two channels.

### Graph drift / delta

- The feature graph's `capability.data-observability` registers this spec and the two code seeds
  `createMcpTelemetryTracker` and `reportMcpTelemetryToArms`, see
  `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`.
- Three lifecycle events are kept; CPU / memory sampling and resource attributes follow the all-process spec. A
  suspected orphan over 60 s is kept only as an internal tracker fact.
- No codegraph tool was available; seeds were traced by exact symbol text to depth 2:
  `createMcpAdapterConnectionPool` (protocol entrypoint -> session lease, process-tracker owner),
  `NodeMcpAdapter.openServerConnection` (pool adapter -> stdio transport, start/crash/PID authority),
  `createZCodeProcessResourceSampler` (protocol notification -> service -> Host -> main, forwarding pattern).

## Case planning

### Boundary decisions

| Boundary          | Decision                                  | Includes                            | Excludes / prunes                    |
| ----------------- | ----------------------------------------- | ----------------------------------- | ------------------------------------ |
| Crash denominator | successful connected stdio instance       | start + unexpected close            | probe/connect failure/expected close |
| Session count     | one first snapshot per session lease      | configured/connected/process/failed | per-server event fan-out             |
| Orphan            | no pool owner for >60 s and still observed | tracker-only suspected orphan       | CLI-death OS sweep                   |

Confirmed with the user: identify the specific MCP (public ID + anonymous device-stable ID + random instance ID);
add orphan detection with the safe ">60 s" threshold; all ZCode Official Marketplace MCPs are `builtin`; built-in
MCPs are not anonymized (official Plugins use the public canonical `mcp_id`).

### Accepted cases

| Case ID      | Setup                                                    | Action                   | Assertions                                                                      | Evidence layers         | E2E status          |
| ------------ | -------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- | ----------------------- | ------------------- |
| MCP-ARMS-001 | connected stdio final transport                          | startup completes        | one start with safe/readable or anonymous ID; probe absent                      | adapter + tracker       | focused integration |
| MCP-ARMS-002 | connected stdio instance                                 | unexpected exit          | one crash with same instance ID/code/signal/uptime                              | adapter + tracker       | focused integration |
| MCP-ARMS-003 | connected stdio instance                                 | deliberate close         | no crash                                                                        | adapter                 | unit                |
| MCP-ARMS-004 | session has stdio + HTTP + failed server                 | first snapshot           | configured/connected/process/failed counts once                                 | pool                    | unit                |
| MCP-ARMS-005 | shared stdio connection, two sessions                    | acquire/release leases   | each session process_count=1; owner count 2 -> 1                                | pool + tracker          | unit                |
| MCP-ARMS-006 | tracked process has no owners                            | sample at 60s / 60s+1ms  | false at 60s, true after 60s                                                    | tracker                 | unit                |
| MCP-ARMS-007 | valid/invalid notification and Host message              | forward                  | strict validation, local/remote only, mobile excluded                           | shared/service/Host     | unit                |
| MCP-ARMS-008 | main receives each event kind                            | report                   | exact three lifecycle ARMS names; legacy memory ignored                         | Desktop reporter        | unit                |
| MCP-ARMS-009 | ZCode Official Marketplace and Personal Source Plugin each declare a stdio MCP | discover + process start | official Plugin source=builtin with a readable ID; Personal Source source=plugin with an anonymous ID | loader + pool + tracker | unit                |

GUI/conversation product state is unchanged; no new conversation case-catalog/E2E-matrix combination is added.
