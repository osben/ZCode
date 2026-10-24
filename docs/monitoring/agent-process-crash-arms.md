# Agent Process Crash ARMS Reporting

## Goal

Desktop Host-launched ZCode Agent is a regular Node child process, not included in Electron
`child-process-gone` automatic collection range. When Agent exits unexpectedly, the existing
`RuntimeProcessLifecycleReporter` needs to actively send the crash fact to desktop main, then main
calls ARMS `sendCustom`.

This functionality simultaneously satisfies:

- `perf_agent_start.value=1`, as the denominator for Agent runtime-level crash rate.
- `perf_agent_ready.value=1`, indicating the same runtime has passed provider/model gate and can execute models.
- `perf_agent_crash.value=1`, for counting Agent crash occurrences.
- Original events retain sanitized, length-limited error information, supporting aggregation by error code and stable fingerprint.
- Active closure, workspace restart, application exit are not counted as crashes.
- Mobile remote control continues to reuse desktop shared host, not duplicating reports in relay or Web end.

## State and Timing

```text
Agent stderr
   │
   ├─ Node spawn successful
   │    └─ host IPC → desktop main → perf_agent_start
   │
   ├─ Agent service passes provider/model gate
   │    └─ ProcessManager.markReady (idempotent once per runtime)
   │         └─ host IPC → desktop main → perf_agent_ready
   │
   ├─ Host services: sanitize and retain last 20 lines
   │
   └─ Agent exit
        │
        ├─ terminationIntent=expected
        │    └─ Only do process registration cleanup, do not send perf_agent_crash
        │
        ├─ terminationIntent=watchdog_recycle
        │    └─ Request timeout recycle, do not mix into crash
        │
        ├─ desktop lifecycle=app_quit/update_install
        │    └─ main has entered irreversible exit process, do not send perf_agent_crash
        │
        └─ No terminationIntent
             └─ host IPC → desktop main
                  ├─ terminationReason=protocol-close
                  │    └─ Even if ultimately SIGTERM / 0x40010004, still send perf_agent_crash
                  │
                  ├─ No structured root cause, and exitCode=0x40010004 / signal=SIGTERM
                  │    └─ Controlled termination noise, do not send perf_agent_crash
                  │
                  └─ Other unexpected exit
                       └─ ARMS perf_agent_crash(value=1)
```

`protocol-close` is a common result after Agent crash, not an active exit intent, prohibits marking exit as expected based on this.

Desktop main is the sole source of truth for application exit lifecycle. `perf_app_exit` emitted must continuously maintain
`app_quit` / `update_install` until process exit; Host IPC late Agent exit even if lacking
termination intent, cannot be remixed into runtime crash. Additionally, local desktop RUM boundary treats
Windows `0x40010004` and POSIX `SIGTERM` as controlled termination characteristics when lacking structured root cause: even
if Host does not provide termination intent, crash is not reported. `protocol-close` itself cannot establish active exit
intent; Host must map first cleanup reason as `terminationReason` to desktop main. Even if subsequent
process tree recovery produces the above system exit characteristics, desktop RUM still reports crash by protocol fault. This
compat classification only affects desktop RUM, does not rewrite Host process lifecycle events.

Ready state is held by Agent service because "process already spawned" and "executable model" are two different stages.
ProcessManager only responsible for binding first ready with current `runtime_instance_id`, and carrying
`runtimeReady` in exit event. desktop main does not IPC arrive time sequence to infer stage: new Host explicitly maps as
`startup` / `runtime`, maps compatible old Host missing fields as `unknown`.

## Event Contract

### `perf_agent_start`

- `group`: `stability`
- `value`: `1`
- Trigger: Node `ChildProcess` emits `spawn`, confirming runtime has actually started.
- Attributes: `process_role=agent`、`runtime_instance_id`、`runtime_generation`、`provider`.

### `perf_agent_ready`

- `group`: `stability`
- `value`: `1`
- Trigger: Same runtime first passes provider/model gate, and remains the current live process.
- Attributes: `process_role=agent`、`runtime_instance_id`=`runtime_generation`=`provider`、
  `startup_duration_ms`.
- Same `runtime_instance_id` reported at most once; read-only start but provider/model not yet ready only produces
  `perf_agent_start`, not ready.

### `perf_agent_crash`

- `group`: `stability`
- `value`: `1`
- Trigger: Agent runtime has been created, but process exits without active exit intent. Lack of structured root cause
  `0x40010004` / `SIGTERM` still suppressed by controlled termination feature; `terminationReason=protocol-close`
  not affected by final exit signature. Even if `exitCode=0`, long-running Agent self-termination also counts as unexpected exit.

Attributes:

| Field                 | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `process_role`        | Fixed to `agent`                                                   |
| `incident_kind`       | Fixed to `unexpected_exit`                                         |
| `exit_code`           | Empty string if no exit code                                       |
| `signal`              | Empty string if no signal                                          |
| `termination_reason`  | Host-retained structured exit root cause, e.g. `protocol-close`    |
| `error_name`          | Extracted from stderr tail, `AgentProcessExit` if unrecognized     |
| `error_code`          | Extracted from Node error output, e.g. `EPIPE`                     |
| `error_message`       | Sanitized error summary                                            |
| `error_stack`         | Sanitized stderr tail, max 4000 characters                         |
| `error_fingerprint`   | Normalized error name, error code and first error line stable hash |
| `stderr_line_count`   | Agent lifetime stderr output line count                            |
| `runtime_instance_id` | Random opaque ID generated per spawn, no workspace/PID             |
| `runtime_generation`  | Current workspace Agent runtime generation                         |
| `uptime_ms`           | Agent alive time from spawn to exit                                |
| `crash_phase`         | `startup` / `runtime` / `unknown`                                  |
| `termination_class`   | `exit_zero` / `exit_nonzero` / `signal` / `unknown`                |
| `diagnostic_class`    | `oom` / `sqlite` / `errno` / `generic` / `none`                    |

Diagnostic summary extracted by determinism priority: OOM → SQLite → errno → generic exception → no diagnosis. `[Object]`,
object closing parenthesis, GC header, native stack address, Node internal location and SQLite ExperimentalWarning
are retained only in sanitized `error_stack`, not allowed to become `error_message`. OOM uses
`AgentOutOfMemory / ERR_OUT_OF_MEMORY`; errno must put `EPERM`、`EPIPE` etc. into
`error_code`; SQLite aggregates via `diagnostic_class=sqlite` even without SQLite code.

### `perf_agent_spawn_error`

- `group`: `stability`
- `value`: `1`
- Trigger: Agent command or cwd cannot spawn.
- Attributes reuse `error_name`、`error_code`、`error_message`、`error_stack`、
  `error_fingerprint`、`diagnostic_class`, and carry this attempt's `runtime_instance_id`.

## Exit Classification

| Cause                                          | Classification                                  | Report crash |
| ---------------------------------------------- | ----------------------------------------------- | ------------ |
| `workspace-dispose`                            | `expected`                                      | No           |
| `manager-dispose` / retry                      | `expected`                                      | No           |
| `request-timeout`                              | `watchdog_recycle`                              | No           |
| desktop `app_quit` / `update_install`          | Application exit protection                     | No           |
| Windows `0x40010004` w/o structured root cause | desktop RUM controlled termination compat class | No           |
| POSIX `SIGTERM` w/o structured root cause      | desktop RUM controlled termination compat class | No           |
| `protocol-close` after any code/signal         | No intent set, keep `unexpected`                | Yes          |
| Other no-cleanup-request code/signal exit      | `unexpected`                                    | Yes          |

First-set termination intent is root cause fact, subsequent idempotent cleanup does not override it.

## Privacy and Capacity

- Prohibit uploading `workspacePath`、`workspaceIdentity`、command、args、environment variables、
  session/task ID or model input/output.
- services layer first masks token、cookie、authorization、password、secret etc. assignments.
- services and desktop main both mask non-prefixed `sk-...` API key; error text must not
  bypass masking due to missing `token=` / `Authorization` prefix.
- desktop main then replaces workspace absolute path with `<workspace>`, error details truncated to
  4000 characters.
- desktop main simultaneously replaces common Windows/macOS/Linux user home directories; before fingerprint generation
  further removes any absolute path, UUID, PID and line/column number, avoiding path leakage and high cardinality.
- ARMS reporting is side-channel observation; any schema, IPC or `sendCustom` failure cannot
  affect Agent startup, exit and auto-recovery.

## Agent Process-Level Exception Boundary

Protocol mode (`app-server` / `agent-server`) installs process-level exception boundary at CLI entry, covering:

- `uncaughtException`
- `unhandledRejection`
- `uncaughtExceptionMonitor`

This boundary writes diagnostic information to `stderr`, does not write diagnostic text to stdout, avoiding
breaking ZCode Protocol NDJSON channel. Reaching here unknown exception means business layer failed to recover: first
exception report after which CLI lifecycle owner has bounded exit, not accepting new business. Ordinary request/model/tool
errors still handled in original business boundaries.

```text
uncaughtException / unhandledRejection
             │
             ▼
CLI process-level boundary
             │
             ├─ stderr: record type, error name, message and stack
             ├─ stdout: write no diagnostic text
             └─ CLI owner stop taking work, cancel and cleanup, non-zero exit
```

The stderr writing boundary independently absorbs this stream's sync/async failure and disables the outlet (so an
async EPIPE cannot re-trigger the boundary and loop on a broken pipe); EPIPE of other streams is never globally ignored. `uncaughtExceptionMonitor`
only records origin, strict rejection still unified reported by rejection listener. Cleanup-period subsequent exceptions
do not repeat diagnosis, do not extend first exit time limit. Full timing see CLI protocol process lifecycle spec.

This boundary only installed in protocol mode, does not change ordinary headless CLI、TUI、doctor、login etc. commands'
original failure exit semantics. `perf_agent_crash` still indicates actual exit; whether exit occurs after exception does not affect JS error reporting.

### CLI JS Exception Reporting

The Electron SDK cannot automatically capture Node child process exceptions and stderr only goes to debug / exit
tail, so `exception` is sent explicitly when an exception occurs instead of relying on exit-log `console.error`
auto-collection.

```text
CLI exception boundary (errorId unique fact source)
  → stderr single line [zcode-process-exception] JSON v1
  → ProcessManager validate / sanitize / bind current runtime_instance_id
  → RuntimeProcessLifecycleReporter.onException
  → Host IPC agent-process-exception (runtime schema validation)
  → desktop main sendEvent(exception, type=error)
  → RUM JS error
```

- Shared public contract is `@zcode/shared/process-diagnostic`, and exported from ZCode Protocol entry.
  CLI / SEA build alias must precisely declare this subpath, avoiding being pulled into index.ts by generic shared alias.
  Fields are `version/errorId/kind/origin/name/message/stack/occurredAt`; kind/origin only accept
  uncaughtException / unhandledRejection. Name max 128 characters, message 4000, stack 16000,
  JSON line max 128 KiB (covering JSON escaping expansion); unknown version, extra fields, damaged frames not forwarded.
- Same monitor + uncaughtException only output once by the latter.
  When using Node strict rejection mode, Node first triggers origin=unhandledRejection's uncaughtException,
  handled then triggers unhandledRejection; this situation unified reported once by the latter, avoiding same rejection double-count.
  Original readable stderr retained for old Host and crash tail use; new Host does not add structured lines repeatedly to tail. CLI early startup
  able to output, not dependent on stdout protocol readiness; diagnostic itself adds no timers, retry queues or business state, exit time limit
  by CLI lifecycle unified held. Any serialization/write failure cannot re-throw.
- ProcessManager only uses runtime identity at time of creating that child, not by path query "current process", avoiding
  late-arriving old process exception attributed to new runtime. IPC exception is observation side-channel, not participating in ready / exit / task state.
- Main is RUM SDK and deduplication state sole owner: by runtimeInstanceId + errorId retain recent
  1024 submitted events; SDK sync failure not record success. Same stack different errorId must be separately counted.
  Not guarantee pre-force-kill unwritten pipe exception delivery, not via exception infer process already recovered or crashed.
- RUM event retains original error name, sanitized message and stack, attached with process_role=agent、process_error_kind、
  process_error_origin、error_id、runtime_instance_id、runtime_generation、lane（if any）、
  app_version、arms_env、device_mid and stable fingerprint; follow main's sanitization and 4000 character limit;
  no upload of workspace, command or task/session identifiers.
- Already gone through lifecycle reporter's exit/spawn failure log with clear diagnostic tag, only filter this
  console.error wrapped event; local error log retained, other console.error continue collection.
  "perf_agent_crash / perf_agent_spawn_error reported" changed to info, avoid reporting success then producing JS error.
- New/old CLI/Host mixed use retains original crash reporting; new exception contract does not change stdout wire version.
  This covers desktop Host directly launched CLI; independent terminal CLI、SSH/WSL/Docker remote Agent independent
  collection entry not in this new range. Mobile shared-host reuse this side-channel, not duplicate in relay/Web,
  desktop continuous and web replayable task events, owner/lease/queue semantics unchanged.

Verification: real CLI separately inject throw / rejection, before exit appears once JS exception; then bounded
exit 1 produces one actual exit event, no wrapper log JS error. Host after stderr drain generates exit tail,
cannot in child exit event or send EOF before turn off diagnostic reader.
Cover IPC illegal input, non-Error rejection, production debug disabled, cross-platform path sanitization, duplicate events,
reporting failure isolation. Online verification simultaneously records SDK request/HTTP response, and in RUM check index results by unique marker.
