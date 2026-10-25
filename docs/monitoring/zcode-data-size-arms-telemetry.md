# ZCode Data Directory Size ARMS Report

## Summary

Desktop collects and reports the logical byte size of the local ZCode data root
`getZCodeDataRootDir()` at most once per device every 24 hours. Collection waits for a
low-interference window (system idle, no ZCode task running, window in the background). The
directory traversal runs in a Worker thread; Electron main only schedules and sends the final ARMS
`sendCustom`.

The old `perf_resource_disk_space` measured Electron `userData` and the install directory, which is
not the user's ZCode data directory. This feature uses the separate event
`perf_resource_zcode_data_size` so old and new definitions are not mixed. The generic resource
window no longer sends the old event.

```text
app/ARMS ready
      |
      v
read persisted state ---- failed ----> fail closed, retry state read after 6h
      |
      +-- missing -------------------> first startup schedule
      |
      +-- recent success/reservation -> wait until 24h due time + device jitter
      |
     due / no history
      v
wait 2..10min startup jitter / poll every 5min
      |
      +-- system idle >= 5min
      +-- no Agent task running
      +-- app is background
      |
      v
Worker scans getZCodeDataRootDir()
      |
      +-- activity resumes before 6h fallback --> abort, retry after 30min
      +-- scan failure ------------------------> retry after 6h
      +-- complete / partial -----------------> persist report reservation
                                                   |
                                                   +-- persist failure --> do not send
                                                   |
                                                   v
                                             main sendCustom
                                                   |
                                                   v
                                         confirm lastReportedAt
```

After waiting 6 hours for the low-interference window, only the system-input-idle and
window-background requirements are relaxed. Running ZCode tasks still block the scan. This avoids
permanently missing samples on always-active devices without competing for disk with model
generation, commands or automations.

## Metric contract

Event: `perf_resource_zcode_data_size`, `group=resource`.

| Field                 | Meaning                                                         |
| --------------------- | --------------------------------------------------------------- |
| `value`               | `zcode_data_bytes` counted in this run                          |
| `metric_kind`         | fixed `zcode_data_bytes`                                        |
| `zcode_data_bytes`    | sum of regular-file `stat.size`                                 |
| `scan_status`         | `complete` / `partial`                                          |
| `partial_reason`      | `time_limit` / `file_limit` / `io_error`; omitted when complete |
| `scan_duration_ms`    | Worker scan wall-clock time                                     |
| `files_scanned`       | regular files counted                                           |
| `directories_scanned` | directories opened successfully                                 |
| `scan_error_count`    | permission errors, vanished files and other local IO errors     |
| `data_root_kind`      | `default` / `custom`                                            |
| `schema_version`      | fixed `1`                                                       |

Desktop main still writes the common dimensions `device_mid`, `platform`, `app_version`,
`arms_env`, `event_name` and `metric_value`. The payload must never contain the absolute data root
path, file or directory names, user name, project paths, workspace/session/task ids, remote
targets or credentials.

`zcode_data_bytes` is a cross-platform logical file size, not filesystem allocation blocks.
Symlinks are not followed (no loops, no escaping the data root). Directories can change during the
scan, so the result is a low-frequency approximate snapshot without filesystem-transaction
consistency.

## Scheduling and state

- Before sending, `reportReservedAt` is written atomically as the rate-limit reservation; if the
  write fails, nothing is sent. After a successful send the reservation is removed and the real
  `lastReportedAt` is written; after a failed send the previous state is restored and the report is
  retried after 6 hours. If the process exits between reservation and send, startup conservatively
  treats the report as sent: one missing sample is preferred over a duplicate.
- Only an explicitly missing state file means "no history". A state read, parse or format failure
  must fail closed: no scan, no report, state re-read after 6 hours, and first-startup scheduling is
  not entered before a retry succeeds. State read retries reuse the scheduler's single timer and
  must not accumulate timers.
- No history: after ARMS ready, delay 2-10 minutes by a stable per-device hash.
- With history: the 24-hour due point plus a stable 0-60 minute jitter computed from
  `device_mid + due bucket`. On startup restore the effective due point including jitter must be
  computed first; after the base 24-hour due the scheduler must not fall back to startup jitter.
  Devices must not converge on one clock time.
- Due but not low-interference: re-check every 5 minutes.
- After 6 hours of waiting, collection only requires no running ZCode task.
- If low-interference conditions break during a scan, the Worker is terminated and retried after 30
  minutes; a 6-hour fallback scan is terminated only when a new ZCode task starts. Eligibility is
  re-checked synchronously after the Worker returns and after the reservation write, before
  sending, to close the race window between activity polls.
- Scan or Worker failure sends no zero value, does not update success state, and retries after 6
  hours.
- Both `complete` and `partial` are successfully delivered samples and update `lastReportedAt`;
  dashboards must filter `scan_status=complete` for exact statistics, `partial` is only a lower
  bound.
- On app exit the timer is cleared and the Worker is terminated without waiting for the scan.

Scheduler state is persisted in a dedicated state file under Electron `userData`. It does not reuse
`~/.zcode/v2/telemetry-state.json`, to avoid contending with the `/report` telemetry state's
process lock and write semantics and to keep the state file from changing the measured directory
size.

## Scan protection

Defaults:

- max wall-clock time: 30 seconds;
- max regular files: 200,000;
- a single Worker;
- symlinks not followed;
- a local IO error continues the scan and marks the result `partial/io_error`;
- reaching the time or file limit ends the scan immediately and marks `partial`.

The old synchronous scan counted at most 50,000 regular files without exposing that the result was
incomplete. That main-process synchronous traversal is removed; the limits are only Worker resource
protection and must not pass as a complete value.

## Feature impact

- Capability: `capability.zcode-data-size-telemetry` / `capability.data-observability`; change
  layer `commit-effect` + `persistence`.
- Seeds: `getZCodeDataRootDir`, the directory scan Worker, the idle scheduler, the ARMS reporter.
- Out of scope: UI, remote machine `~/.zcode`, free disk space, directory cleanup, conversation
  delivery. There is no UI entry; the feature is Desktop-main app-global only and isolated from
  renderer, remote host, mobile replay and the task stream.
- Data root: services path source of truth; default/custom only changes `data_root_kind`. Electron
  userData is not the business data root.
- Existing reuse: `configureDesktopResourceTelemetry` (ARMS-ready bootstrap, the resource reporter
  owner) and `hostRunningTaskCountMap` (Host task reporter -> main map -> app lifecycle count) as
  the running-task fact; no new queue.

### State owners and commit sinks

| State/fact       | Authoritative owner        | Commit                | Persistence                   |
| ---------------- | -------------------------- | --------------------- | ----------------------------- |
| data root        | services path config       | `getZCodeDataRootDir` | setting/dataBaseDir           |
| due time         | Desktop scheduler          | timer decision        | dedicated userData state file |
| idle eligibility | Electron main observations | scheduler decision    | none                          |
| scan result      | one-shot Worker            | worker message        | none                          |
| final event      | Desktop main               | `armsRum.sendCustom`  | ARMS                          |

### Must-preserve invariants

| Invariant                                                                       | Proof                               |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| no synchronous directory traversal in main                                      | scanner runs in Worker (unit/build) |
| no user path/name in payload                                                    | exact payload test                  |
| at most one successful report per 24h                                           | persisted scheduler test            |
| a running ZCode task always blocks the scan                                     | state-machine test                  |
| partial is distinguishable from complete                                        | scanner + payload test              |
| remote/mobile delivery unchanged                                                | no protocol/schema edits (static)   |
| data-size event never enters continuous/replayable conversation delivery        | architecture/spec                   |
| local data root only; remote `~/.zcode` (SSH/WSL/Docker/server) never inspected | spec                                |

## Case planning

Decisions: root `getZCodeDataRootDir()` (default/custom local root, not userData or remote root);
schedule 24h + device jitter; idle = 5 min OS idle + app background + no task with 6h fallback;
scan = Worker with 30s/200k caps counting regular-file logical bytes; payload = one primary size
plus quality metadata (no path/name/task/workspace). Dimensions covered: root (missing/default/
custom/nested), due (fresh/due/overdue >6h), activity (idle/background, active/foreground, task
running), result (complete/time limit/file limit/io error/failure). Platforms are
representative + static (Worker uses Node fs, no shell command); desktop-vs-mobile delivery and
remote kinds are pruned by invariant.

| Case ID       | Setup                             | Action            | Assertions                                 | Layers               |
| ------------- | --------------------------------- | ----------------- | ------------------------------------------ | -------------------- |
| DATA-SIZE-001 | nested regular files              | scan              | exact byte/file/directory counts, complete | filesystem + unit    |
| DATA-SIZE-002 | more files than limit             | scan              | partial/file_limit, value is lower bound   | filesystem + unit    |
| DATA-SIZE-003 | zero time budget                  | scan              | partial/time_limit                         | filesystem + unit    |
| DATA-SIZE-004 | due + idle + background + no task | scheduler check   | one scan/report, persist success           | state machine + unit |
| DATA-SIZE-005 | due + user active before 6h       | scheduler check   | no scan, retry in 5min                     | state machine + unit |
| DATA-SIZE-006 | overdue wait >=6h + no task       | scheduler check   | fallback scan despite foreground activity  | state machine + unit |
| DATA-SIZE-007 | any due state + task running      | scheduler check   | no scan                                    | state machine + unit |
| DATA-SIZE-008 | partial result                    | build/send event  | primary bytes + quality fields, no path    | payload + unit       |
| DATA-SIZE-009 | recent persisted success          | restart scheduler | no report before 24h+jitter                | persistence + unit   |
| DATA-SIZE-010 | report reservation write fails    | due collection    | scan may finish, but no event is sent      | state machine + unit |
| DATA-SIZE-011 | task starts before final send     | finish scan       | abort without reporting                    | state machine + unit |
| DATA-SIZE-012 | restart inside daily jitter       | restore scheduler | wait until effective due time              | persistence + unit   |
| DATA-SIZE-013 | persisted state read/parse fails  | start scheduler   | no scan/report; retry state read after 6h  | persistence + unit   |

E2E is not needed for any case (bounded local Worker behavior). No open questions: root definition,
logical bytes, 24h period, jitter, idle gating, 6h fallback, scan limits, partial semantics,
privacy fields and local-only boundary were confirmed by the user.
