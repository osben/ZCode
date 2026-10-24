# ZCT-2099792881319157760: Provider File Lock and Missing Configuration Investigation

- Investigation date: 2026-09-15.
- Primary event: 2026-09-13, Windows desktop 3.12.1, release build `dfc10615`.
- Materials: feedback attachment `284720`, `zcode-logs-full-20260915-173012.zip`; six Desktop/CLI run logs from September 13-15, 58,443 lines.
- Scope: September 13 configuration file lock failures, personal Provider disappearance, and recovery behavior. The September 15 configuration validation failures were confirmed by the feedback follow-up as user-manual configuration corruption and are a separate issue.
- Status: investigation report. Configuration degradation and recovery defects are confirmed; the on-site trigger for repeated lock timeouts is unresolved. The lock-competition part was later reduced by [the pure-read lock-removal change](./2026-09-15-provider-config-read-lock-todo.md); the other defects below remain open.

Conclusion: multiple processes poll the same personal Provider configuration under an exclusive lock, so readers contend continuously. In some periods on-site, lock acquisition timed out and the read layer converted the exception into an empty personal configuration. The Provider then disappeared from the available set and subsequent message execution could fail. After reading recovers, the recovery notification can be missed because the disk content version is unchanged. Abnormal operation delays on Sunday correlate with frequent minimizing, but the materials do not show whether the delay came from system scheduling, I/O, game load, or screen lock.

## 1. Issue Path

### 1.1 Involved files and state

| Object                                       | Purpose                                                                       | Relation to this issue                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `provider_config.json`                       | Saves personal Provider, model rules, and other configuration                 | File that failed to read                                                                      |
| `provider_config.json.lock/owner-*.json`     | Cross-process exclusive lock via directory and owner file                     | Even pure polling creates, writes, and deletes this lock metadata                             |
| In-memory Provider Registry                  | Provides available Providers for model settings, model selection, and runtime | May receive empty personal configuration and keep the degraded state after the fault recovers |
| `setting.json` and its independent file lock | Saves app preferences, last workspace, etc.                                   | Repeated saving is a side finding; it does not occupy the Provider file's lock                |
| SQLite session library                       | Saves session and related data                                                | Different lock mechanism; no evidence that a migration failure triggered this fault           |

### 1.2 Chain

```text
Host and multiple Agents use the same Personal Provider config path
Each Repository polls by default approximately every 1 second
                         ↓
Read and update use the same exclusive lock; readers also wait for each other
Each successful lock acquisition creates a directory, writes an owner, and verifies ownership
                         ↓
Some periods complete operations noticeably slower, potentially amplifying lock contention
[Inference: Which PID, which step was slow on-site, remains unconfirmed]
                         ↓
Some requests fail to succeed within the lock-wait budget, reporting lock timeout
                         ↓
Poll failure triggers upper-level refresh and new read
                         ↓
New `read()` also fails, catches the exception, and successfully returns an empty Personal Overlay
                         ↓
Registry publishes new available state based on this empty personal configuration
Personal Provider / models disappear; subsequent messages may fail to create models
                         ↓
Later polling succeeds, reading the original disk content version R1
Repository still remembers R1, considers content unchanged, does not send change
                         ↓
Downstream may keep the degraded view until another refresh or restart
```

The default 8 seconds is a wall-clock wait budget for cross-process lock acquisition. It excludes prior in-process FIFO queuing and is not a single `readFile` timeout or lock-holding duration. A timeout does not mean another process held the lock for 8 seconds; accumulated costs from several competitions, retries, or delayed operation completions can exhaust the budget.

A new poll is scheduled only after the previous one completes, so the 1-second interval is not a strict rate during the anomaly. A normal `read()` also does old config import and format normalization write-back; pure polling does not modify the config body but still acquires the lock.

### 1.3 Timeline

Times are Host message inner time. The outer time in Desktop logs is Main's receive/forward time and may lag.

| Time                         | Log fact                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 15:44                        | Loaded normally after upgrading to 3.12.1; Host Registry's `providerCount=8`                                     |
| 18:07:56–58                  | Host 30660 loaded config normally; four Agents completed database migration checks                               |
| 18:38:10–19:08:02            | First round: 11 poll alerts, 16 read degradations, 26 lock timeouts and 1 `mkdir EPERM`                          |
| 19:10:10                     | New Host 31780 loaded normally, recovering to 8 Providers; personal configuration content version same as before |
| 19:23:51–19:27:06            | Second round: 1 poll alert, 5 read degradations, all lock timeouts                                               |
| 19:28:59                     | New Host 25264 loaded normally, 8 Providers; content version same                                                |
| 20:24:48–20:28:50            | Third round: 4 poll alerts, 4 read degradations, all lock timeouts                                               |
| 20:34:49, 20:35:03, 20:35:12 | Same task accepted three short inputs; all failed in model creation with `provider_not_found`                    |
| 21:40, 22:11                 | Startups loaded 8 Providers normally; content version same                                                       |
| 22:13–22:14                  | 1 delete Provider and 2 save Provider Overlay RPCs succeeded                                                     |
| 22:15                        | Host startup loaded 7 Providers; content version changed                                                         |

Daily total: 16 poll alerts, 25 read degradations, i.e. 40 lock timeouts and 1 lock directory creation failure. The count only compares Host `Provider Registry ready` events, not `providerCount` from other layers.

The primary problem during the fault was in-memory configuration degradation; the disk configuration could still be read after restart. A `read()` returning empty configuration does not overwrite the disk, and `update()` re-reads the disk inside the lock before modifying, so "any save after degradation writes an empty disk" cannot be derived.

### 1.4 Impact and recovery boundaries

- 31 model network completions were recorded in the first round: 24 used the original custom provider model, 7 used account models. Running tasks and configuration lists can be in different states; continued task output does not prove the configuration view is healthy.
- The three `provider_not_found` events at 20:34–20:35 show subsequent messages could fail to execute. The Host send RPC returning `OK` only means the request was received.
- The same Host's poll alert fires only on the first consecutive failure and resets on a successful read, so intermediate successful polls do not prove one residual lock persisted all evening.
- Of 40 timeouts, 33 nested causes carry the native `mkdir EEXIST` field and 7 carry only `code=EEXIST`. The latter strongly points to the post-creation ownership verification branch, but without the original message/stack the failed sub-condition is unconfirmed.
- Isolated probes verified the mechanism "Registry becomes empty after read failure; disk recovers but Registry does not auto-recover; explicit refresh recovers". Lock delay and deletion failure fault injection only proves the defect can occur, not that on-site conditions matched the injection.

## 2. System Environment

### 2.1 Sunday vs. Monday and Tuesday

| Metric                             | September 13, Sunday | September 14, Monday | September 15, Tuesday |
| ---------------------------------- | -------------------: | -------------------: | --------------------: |
| Minimize commands                  |             21 times |              5 times |               2 times |
| Setting save phase pair count      |                  264 |                  211 |                   265 |
| Setting save phase median duration |                  7ms |                  5ms |                   5ms |
| Setting save phase max duration    |             16,626ms |                 26ms |                  36ms |
| Setting saves exceeding 1 second   |              3 times |              0 times |               0 times |
| Provider file lock timeout         |             40 times |              0 times |               0 times |

Save phases pair the same Host's `writing settings` / `write done` inner times, with no unmatched records. The duration includes directory operations, compatible field reads, lock acquisition, writing, replacement retries, and scheduling dispatch; it is not physical disk write time and not the whole `setting.update` RPC.

Monday and Tuesday still ran 3.12.1 with the same custom Provider, so an upgrade fix did not remove the problem. Both days had mostly four Agents, real configuration modifications, and task executions (159 and 149 model network completions). Monday had other model parameter, upstream response, and network errors but no Provider configuration loading degradation. Tuesday's configuration validation failures from 17:20 are the confirmed manually-corrupted configuration and cannot be combined with Sunday's lock issue. Tuesday's attachments end at 17:30.

### 2.2 Minimizing is a related clue, insufficient alone

Third-round correlation:

| Minimize | Next Provider poll alert |    Interval |
| -------- | ------------------------ | ----------: |
| 20:24:30 | 20:24:48                 | ~18 seconds |
| 20:25:04 | 20:25:18                 | ~14 seconds |
| 20:26:03 | 20:26:18                 | ~15 seconds |
| 20:27:40 | 20:27:51                 | ~12 seconds |

But earlier Sunday minimizations were normal and no lock alerts appeared after 20:35. Monday 09:31, 14:44 and Tuesday 12:47 minimizations during running tasks also had no lock timeouts. "Multiple Agents + minimizing" is not a sufficient trigger.

User behavior resembles repeatedly checking the app during long task runs and checking settings and attempting recovery after faults (18:42–18:44 settings/Provider views, 18:59 built-in file explorer, restarts at 19:10 and 19:29). Some RPCs are automatic queries. Without complete focus/restore trails, per-session background dwell time cannot be reconstructed.

### 2.3 Current judgment and what cannot be concluded

The better-supported direction: abnormal operational latency in some Sunday periods amplified multi-process exclusive polling competition; Monday and Tuesday did not repeat it. The latency source is unconfirmed.

- No on-site records of game processes, other foreground applications, or full-system resource load; gaming or resource saturation cannot be concluded.
- 3.12.1 records no screen lock, unlock, sleep, or wake events; absent logs do not exclude them. Screen lock is not system sleep; runtime logs do not support continuous sleep through the fault window.
- "Keep computer running" was off on all three days; this does not imply actual system sleep.
- No `ENOSPC`, `SQLITE_FULL`, or other full-disk errors and no free-space data at fault time; neither disk full nor sufficient space can be concluded.
- The last database migration checks completed at 18:07:58; the first Provider error was at 18:38. No evidence that migration failure triggered the lock fault.

Microsoft documentation states that window visibility affects process and descendant QoS; minimized or fully obscured windows fall into Low, and some power-saving strategies depend on battery power ([Windows QoS](https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service)). This is an investigation direction, not proof of the latency source. Electron lock screen, unlock, sleep, and resume events can supplement state records without scanning the user's other applications ([Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)).

## 3. Core Provider Design Defects

### 3.1 High-frequency read-only operations use exclusive locks

Config changes need Host and Agent synchronization, so periodic reads serve a purpose. The current implementation has multiple processes independently polling the same file, pure readers excluding each other, and lock metadata writes and deletions around every successful read, which creates sustained competition and sensitivity to abnormal completion latency.

The goal is to reduce repeated reads and unnecessary reader exclusion; that is not the same as "must change to read-write locks". Normal `read()` includes import and normalization write-back, so pure reads must be distinguished from read-write operations before cross-process consistency is decided. Removing all read locks or extending timeouts is not a complete design.

### 3.2 Temporary read failures treated as valid empty configuration

A lock timeout means the latest configuration was not obtained, not that the user deleted all personal Providers. `read()` catches errors and returns an empty Personal Overlay, so the Registry replaces its state with it.

Constraint: temporary unreadability must not impersonate a real empty configuration. When an effective snapshot exists, a single temporary read failure must not clear it. On first startup with no effective snapshot, the unavailable state must be expressed explicitly, not disguised as "user has not configured".

### 3.3 Recovery only checks file content, not downstream state

The Repository recorded content version R1; the Registry receives an empty configuration after read failure while the Repository's observed version may still be R1. Later polling reads R1 back, finds the version unchanged, returns early, and misses the downstream recovery notification.

```text
Normal: disk R1, observed version R1, Registry normal
Failed: disk R1, observed version R1, Registry degraded to empty
Recovery: disk R1, version unchanged → no notification → Registry may remain empty
```

Constraint: unchanged file content does not mean unchanged service state; when reading recovers from failure, consumers must be able to return to an effective state. The UI is already subscribed to the Registry; do not misdiagnose upstream recovery events as the page not responding to Registry changes.

Fix priority: first ensure read failures do not destroy existing available configuration and recovery updates downstream correctly; then optimize read and lock competition. Separate designs and regression scenarios are needed before implementation; this report does not fix the final lock scheme.

## 4. Incidental Issues

### 4.1 Unchanged workspace info, yet `setting.json` repeatedly saved

Workspace info is saved to restore the last opened workspace, order, and active items at next startup. `TabStore` holds workspace/settings tabs, the active tab, and sidebar expand state together; the persistence listener subscribes to the whole store and, after a 300ms debounce, extracts only `lastWorkspaceSession` and `lastActiveTabIndex`. The listener does not compare extracted results and the service layer does not compare old and new settings after merging. So opening settings, collapsing projects, or reactivating an existing workspace can also trigger a save.

```text
Open settings page or collapse project
          ↓
TabStore notification → 300ms debounce
          ↓
Extracted workspace list and activation index are the same as before
          ↓
Still calls setting.update → merges full settings → temp file replacement write-back
```

The 300ms debounce merges dense events; it does not deduplicate content and is not a fixed 300ms save. The minimize command only minimizes the window, with no direct settings save, so post-minimize save logs do not show minimizing writes to disk.

Of 264 save log objects on Sunday, 261 of 263 adjacent pairs were identical. Logs lack call parameters and stacks, so not all duplicate writes can be attributed to this listener, and actual disk writes also merge compatible fields.

Relation to the main issue: (1) repeated saving adds file operations, lock metadata, and scheduling burden that could be reduced; (2) unusually slow concurrent saves are collateral evidence of latency in the shared environment. `setting.json.lock` differs from `provider_config.json.lock`, so workspace setting saves do not occupy the Provider lock. No evidence that repeated saving caused the lock timeout; Monday and Tuesday had plenty of repeated saving without this fault.

### 4.2 Underlying lock release failures ignored, insufficient diagnosis

Errors when releasing (deleting the owner, deleting the lock directory) are ignored. If the owner file remains and its PID is alive, later requests may keep treating it as an active lock and wait continuously. The risk exists in the underlying tool but is not the confirmed on-site trigger; the sole `EPERM` occurred during `mkdir`, not during release.

This is a common tool issue found incidentally; its placement here does not mean small impact. Release errors must be made visible, and after a slow request or failure the log should carry a summary: waiters and owner PID, liveness judgment, attempt count, queue/acquire/hold/release durations, ownership verification failure conditions, and original error type; when necessary, asynchronously read available space of the failing volume at failure time. Records are limited to slow requests, anomalies, and system state transitions (not every round) and must not include config bodies or API Keys. File operation completion durations are not physical disk latency.

### 4.3 Source entry points and log locations

The source was compared against release build `dfc10615`; the core files differ from the investigation workspace.

| Concern                                               | Source code entry                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Personal config read, write, polling, and degradation | `packages/provider-node/src/personal-provider-config-repository.ts`: `read`, `update`, `#pollOnce` |
| Config-layer forwarding and Registry publishing       | `packages/provider/src/config-service.ts`, `packages/provider/src/registry-service.ts`             |
| In-process queuing and file lock budget               | `packages/shared/src/node/privateFilePersistence.ts`: `withFileLock`                               |
| Cross-process ownership verification and release      | `packages/shared/src/node/atomicFileLock.ts`: `acquireFileLock`                                    |
| TabStore and persistence listener                     | `packages/ui/src/store/tabStore.ts`, `packages/ui/src/hooks/useTabPersistence.ts`                  |
| Workspace serialization fields                        | `packages/ui/src/root/remoteWorkspaceSessionPersistence.ts`: `buildRemoteWorkspacePersistPatch`    |
| Setting update and actual disk writing                | `packages/services/src/setting/settingService.ts`: `update`, `writeSettings`                       |

Key log lines (counted after decoding the original files; no user configuration body):

| File                                    | Line                       | Content                                                                |
| --------------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `logs/2026-09-13.log`                   | 11184, 11187               | First poll lock fault and subsequent read degradation                  |
| `logs/2026-09-13.log`                   | 11965                      | `EPERM` for creating lock directory                                    |
| `logs/2026-09-13.log`                   | 14186, 14189               | 16.626s setting save phase                                             |
| `logs/2026-09-13.log`                   | 14652, 16404, 23497, 23872 | Subsequent startups reloaded normal config                             |
| `logs/2026-09-13.log`                   | 22729, 22733, 22734, 22735 | Minimize, 12.314s save, and concurrent Provider lock alert             |
| `.zcode/cli/log/zcode-2026-09-13.jsonl` | 5216, 5221, 5226           | Three subsequent messages failed execution due to `provider_not_found` |

A few bare anonymized placeholders in the CLI export logs caused JSON parse failures; they were normalized in memory during reading. Original files were not modified and this is not evidence of file corruption. Complete user logs are not archived here; access them through the feedback ticket attachments.
