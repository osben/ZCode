# ZCT-2099792881319157760: Provider File Lock and Missing Configuration Investigation

- Investigation date: 2026-09-15.
- Primary event: 2026-09-13, Windows desktop 3.12.1, release build `dfc10615`.
- Materials: feedback attachment `284720`, `zcode-logs-full-20260915-173012.zip`. Reviewed six Desktop/CLI run logs from September 13-15, totaling 58,443 lines.
- Scope: Investigated September 13 configuration file lock failures, personal Provider disappearance, and recovery behavior. September 15 configuration validation failures have been confirmed by the feedback follow-up as user-manual configuration corruption, handled as a separate issue.
- Status: Investigation report. No fix implemented yet. Configuration degradation and recovery defects are confirmed; the specific trigger factors for repeated lock timeouts on-site remain unresolved.

Conclusion: Multiple processes polling the same personal Provider configuration with exclusive locks have sustained reader contention. At certain periods on-site, lock acquisition timeouts occurred, and the read layer converted exceptions into empty personal configuration, causing the Provider to disappear from the available set and potentially blocking subsequent message execution. After reading recovers, it may also miss sending recovery notifications due to unchanged disk content version. Sunday's abnormal operation delays correlate with frequent minimizing, but the existing materials do not determine whether the delay originates from system scheduling, I/O, game load, or screen lock.

## 1. Complete Issue Path Reconstruction

### 1.1 Involved files and state

| Object                                       | Purpose                                                                       | Relation to this issue                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider_config.json`                       | Saves personal Provider, model rules, and other configuration                 | File that failed to read                                                                                                                   |
| `provider_config.json.lock/owner-*.json`     | Cross-process exclusive lock via directory and owner file                     | Even pure polling creates, writes, and deletes these lock metadata                                                                         |
| In-memory Provider Registry                  | Provides available Providers for model settings, model selection, and runtime | May receive empty personal configuration and retain degraded state after fault recovery                                                    |
| `setting.json` and its independent file lock | Saves app preferences, last workspace, etc.                                   | Repeated saving is a side finding; it does not directly occupy the Provider file's lock                                                    |
| SQLite session library                       | Saves session and related data                                                | Locks with the above JSON file directory use different mechanisms; no direct evidence of migration failure triggering this fault was found |

### 1.2 Complete chain

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
Downstream may continue retaining the degraded view until other refresh or restart
```

The default 8 seconds is a wall-clock wait budget for cross-process lock acquisition, not including prior in-process FIFO queuing, nor a single `readFile` timeout or lock-holding operation duration. A timeout does not mean another process holds the lock continuously for 8 seconds; it could also be accumulated costs from multiple competitions, retries, or delayed operation completions exhausting the budget.

A new poll is scheduled only after completion; the default 1-second interval cannot be converted to strictly fixed executions per second during the anomaly period. A normal `read()` also includes old config import and format normalization write-back; pure polling does not modify the config body but still acquires the lock.

### 1.3 Timeline

The table below uses Host message inner time. The outer time in Desktop logs is Main's receiving and forwarding time; there may be latency between the two.

| Time                         | Log fact                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 15:44                        | Loaded normally after upgrading to 3.12.1; Host Registry's `providerCount=8`                                                    |
| 18:07:56–58                  | Host 30660 loaded config normally; subsequently four Agents completed database migration checks                                 |
| 18:38:10–19:08:02            | First round: 11 poll alerts, 16 read degradations, totaling 26 lock timeouts and 1 `mkdir EPERM`                                |
| 19:10:10                     | New Host 31780 loaded normally, recovering to 8 Providers; personal configuration content version same as before normal startup |
| 19:23:51–19:27:06            | Second round: 1 poll alert, 5 read degradations, all lock timeouts                                                              |
| 19:28:59                     | New Host 25264 loaded normally, recovering to 8 Providers; personal configuration content version same                          |
| 20:24:48–20:28:50            | Third round: 4 poll alerts, 4 read degradations, all lock timeouts                                                              |
| 20:34:49, 20:35:03, 20:35:12 | Same task consecutively accepted three short inputs, all failed in model creation with `provider_not_found`                     |
| 21:40, 22:11                 | Subsequent startups loaded 8 Providers normally; personal configuration content version same                                    |
| 22:13–22:14                  | 1 delete Provider, 2 save Provider Overlay successful RPCs occurred                                                             |
| 22:15                        | Host startup loaded 7 Providers; personal configuration content version changed                                                 |

Total for the day: 16 poll alerts, 25 read degradations, i.e., 40 lock timeouts and 1 lock directory creation failure. The full-day count cannot be attributed entirely to the first round. The configuration count only compares Host's `Provider Registry ready` events, not mixing other layers' `providerCount`.

This timeline supports the finding that the primary issue during the fault was in-memory configuration degradation; the original disk configuration could still be read back after restart. This round's `read()` returning empty configuration does not overwrite the disk itself; `update()` reads the disk anew inside the lock before modifying, so it cannot be derived that "any save after degradation writes empty disk."

### 1.4 Impact and recovery boundaries

- 31 different requests' model network completions were recorded during the first round, of which 24 used the original custom provider model and 7 used account models. Running tasks and configuration lists can exist in different states; continued task output does not prove the configuration view is healthy.
- The three `provider_not_found` occurrences at 20:34–20:35 indicate that subsequent messages indeed could fail to execute. The Host's send RPC returning `OK` only means the request was received, not that the subsequent task execution succeeded.
- The same Host's poll alerts appeared multiple times, while the code only alerts on the first consecutive failure and resets on successful read. Therefore, intermediate successful polls cannot be assumed to have been blocked by the same residual lock throughout the evening.
- Of 40 timeouts, 33 nested causes carry the native `mkdir EEXIST` field, and 7 carry only `code=EEXIST`. The latter strongly points to the post-creation ownership verification branch, but without the original message/stack, the specific failed sub-condition cannot be confirmed.
- Isolated probes have verified the mechanism of "Registry becomes empty after read failure, disk recovery read but Registry does not auto-recover, explicit refresh recovers." Lock delay and deletion failure fault injection only proves the defect can occur, not that the on-site conditions matched the same injection.

## 2. Special Circumstances of the System Environment at the Time

### 2.1 Sunday vs. Monday and Tuesday comparison

| Metric                             | September 13, Sunday | September 14, Monday | September 15, Tuesday |
| ---------------------------------- | -------------------: | -------------------: | --------------------: |
| Minimize commands                  |             21 times |              5 times |               2 times |
| Setting save phase pair count      |                  264 |                  211 |                   265 |
| Setting save phase median duration |                  7ms |                  5ms |                   5ms |
| Setting save phase max duration    |             16,626ms |                 26ms |                  36ms |
| Setting saves exceeding 1 second   |              3 times |              0 times |               0 times |
| Provider file lock timeout         |             40 times |              0 times |               0 times |

Save phases are paired by the same Host's `writing settings` / `write done` inner time, with no unmatched records. This duration includes directory operations, compatible field reads, lock acquisition, writing, replacement retries, and scheduling dispatch; it is not the physical disk write duration, nor does it cover the entire `setting.update` RPC.

Monday and Tuesday still use 3.12.1 and the same custom Provider; the problem was not eliminated by an upgrade to a fix. Monday's startups still had four Agents for most periods, with sometimes an additional sub-project Agent opened; Tuesday's main usage periods also had four Agents. Both days had actual configuration modifications and task executions, with 159 and 149 model network completion requests respectively.

Monday had other model parameters, upstream responses, and network errors, but no Provider configuration loading degradation. Tuesday's configuration validation failures from 17:20 onwards belong to confirmed manually-corrupted configuration and cannot be combined with Sunday's file lock issue. Tuesday's attachments only cover until 17:30; degradation results after that are not directly proven by those attachments.

### 2.2 Minimizing is a related clue, insufficient alone

The third-round fault correlation is relatively concentrated:

| Minimize | Next Provider poll alert |    Interval |
| -------- | ------------------------ | ----------: |
| 20:24:30 | 20:24:48                 | ~18 seconds |
| 20:25:04 | 20:25:18                 | ~14 seconds |
| 20:26:03 | 20:26:18                 | ~15 seconds |
| 20:27:40 | 20:27:51                 | ~12 seconds |

But earlier Sunday had multiple normal minimizations, and no lock alerts appeared after 20:35. Monday 09:31, 14:44, and Tuesday 12:47 also had task-running minimizations, with subsequent task completions and no lock timeouts. Therefore, "multiple Agents + minimizing" is not a sufficient trigger condition.

User behavior resembles repeatedly checking the app during long task runs, checking settings and attempting recovery after faults: 18:42–18:44 concentrated reading of settings and Provider views, 18:59 opening ZCode built-in file explorer, 19:10, 19:29 restarting and continuing input after restart. Some RPCs are automatic queries and cannot be explained as individual clicks line-by-line; without complete focus/restore trails, background dwell durations per session cannot be reconstructed.

### 2.3 Current judgment and conclusions that cannot be drawn

The better-supported direction at present is: certain periods on Sunday experienced abnormal operational latency that amplified multi-process exclusive polling competition; Monday and Tuesday did not exhibit the same behavior again. The specific source of the latency remains to be confirmed.

- No on-site records of game processes, other foreground applications, or full-system resource loads; it cannot be concluded that the user was playing games or that resources were saturated at the time.
- 3.12.1 records no screen lock, unlock, system sleep, or wake events; these behaviors cannot be excluded based on absent logs. Screen lock does not equal system sleep; runtime logs do not support continuous system sleep throughout the entire fault window.
- "Keep computer running" was off during all three recorded days, but this does not derive actual system sleep.
- Logs have no `ENOSPC`, `SQLITE_FULL`, or other full-disk errors, nor remaining space data at the time of the fault; it cannot be concluded that the disk is full, nor that insufficient space is entirely ruled out.
- The most recent group of database migration checks completed at 18:07:58; the first Provider error occurred at 18:38. No evidence of migration failure directly triggering this lock fault was found.

Microsoft documentation states that window visibility affects process and descendant QoS; minimized or fully obscured windows fall into Low; some power-saving strategies carry battery-power conditions. This provides a system scheduling investigation direction but does not prove the specific latency source in this case. [Windows QoS](https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service)

Subsequent Electron lock screen, unlock, sleep, and resume events can supplement state records, without scanning the user's other applications. [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)

## 3. Core Design Defects of the Provider

### 3.1 High-frequency read-only operations use exclusive locks

Config changes need synchronization between Host and Agent, and periodic read functionality serves a reasonable purpose. The current implementation has multiple processes independently polling the same file, with pure readers mutually excluding each other, and executing lock metadata writes and deletions before and after each successful read, creating sustained competition and sensitivity to abnormal completion latency.

The improvement goal should reduce repeated reads and unnecessary reader exclusions; this is not equivalent to directly specifying "must change to read-write locks." Normal `read()` includes import and normalization write-back, so pure reads and read-write operations must be distinguished first, then cross-process consistency is determined. Simply removing all read locks or extending timeouts is not a complete design.

### 3.2 Treating temporary read failures as valid empty configuration

A lock timeout means the latest configuration was not obtained, not that the user deleted all personal Providers. Currently, `read()` catches errors and successfully returns an empty Personal Overlay, so the Registry replaces the original state based on it.

The constraint to maintain: temporary unreadability must not impersonate a real empty configuration; when an effective snapshot already exists, it should not be cleared by a single temporary read failure. On first startup with no effective snapshot, unavailable state should also be explicitly expressed, not disguised as user having not yet configured.

### 3.3 Fault recovery only checks file content, without covering downstream state

The Repository has recorded content version R1, the Registry receives an empty configuration after read failure, but the Repository's observed version may still retain R1. Later, polling succeeds reading R1 back, and since the version is unchanged, it returns early and misses the downstream recovery notification.

```text
Normal: disk R1, observed version R1, Registry normal
Failed: disk R1, observed version R1, Registry degraded to empty
Recovery: disk R1, version unchanged → no notification → Registry may remain empty
```

The constraint to maintain: unchanged file content does not mean unchanged service state; when reading recovers successfully from failure, consumers must be able to restore to an effective state. The UI is already subscribed to the Registry; it must not misdiagnose upstream recovery events as the page not responding to Registry changes.

Fix priority: first ensure read failures do not destroy existing available configurations, and that recovery correctly updates downstream; then optimize read and lock competition. Separate designs and regression scenarios are needed before subsequent implementation; this report does not indicate the final lock scheme has been determined.

## 4. Incidental Issues Discovered

### 4.1 Workspace info unchanged, yet `setting.json` repeatedly saved

The purpose of saving workspace info is to restore the last opened workspace, order, and active items on next startup. `TabStore` simultaneously saves workspace/settings tabs, current active tab, and sidebar expand state; the persistence listener subscribes to the entire store, and after 300ms debounce, only extracts `lastWorkspaceSession`, `lastActiveTabIndex`.

The listener layer does not compare extracted results, and the service layer does not compare old and new settings after merging. Therefore, valid changes like opening/closing/rearranging workspaces will save, but operations that do not change these two fields, such as opening the settings page, collapsing projects, or reactivating an existing workspace, may also save.

```text
Open settings page or collapse project
          ↓
TabStore notification → 300ms debounce
          ↓
Extracted workspace list and activation index are the same as before
          ↓
Still calls setting.update → merges full settings → temp file replacement write-back
```

The 300ms debounce only merges dense events, not deduplicating content; it is not fixed 300ms saves. The minimize command itself only calls window minimize, with no direct settings save, so the post-minimize save logs cannot be interpreted as minimizing inevitably writing to disk.

Of 264 save log objects on Sunday, 263 adjacent pairs had 261 identical pairs. This statistic is not affected by anonymized placeholders, but the logs lack call parameters and call stacks, so all duplicate writes cannot be attributed to this single listener entry; actual disk writing also merges compatible fields and does not claim per-disk-byte identity.

The relation to the main issue has two layers:

1. Repeated saving increases file operations, lock metadata, and scheduling burden; it is extra overhead that could be reduced.
2. Concurrent save anomalies being unusually slow provides collateral evidence of latency in the shared running environment.

`setting.json.lock` differs from `provider_config.json.lock`; normal workspace setting saves do not directly occupy the Provider's lock. No evidence was found that repeated saving caused this lock timeout; Monday and Tuesday still had large amounts of repeated saving without this fault.

### 4.2 Underlying lock release failures ignored, insufficient diagnosis

Errors when releasing (deleting the owner, deleting the lock directory) are ignored. If the owner file remains and its PID is still alive, subsequent requests may continue to treat it as an active lock, forming sustained waits. This risk exists in the underlying tool, but it is not the confirmed on-site trigger for this issue; the sole `EPERM` clearly occurred during `mkdir` and cannot be explained as a release-time deletion failure.

This is a common tool issue discovered incidentally; placing it in this section does not mean the potential impact is small. Release errors need to be made visible, and after a slow request or failure, necessary summary information should be logged: waiters and owner PID, liveness judgment, attempt count, queue/acquire/hold/release durations, ownership verification failure conditions, and original error type. When necessary, asynchronously read available space on the volume containing the failure at failure time.

These records should be limited to slow requests, anomalies, and system state transitions, not printed every round, and must not include config bodies or API Keys. File operation completion durations still cannot be directly named as physical disk latency.

### 4.3 Investigation basis and subsequent handoff

The source code was compared against release build `dfc10615`; the following core files differ from the investigation workspace:

| Concern                                               | Source code entry                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Personal config read, write, polling, and degradation | `packages/provider-node/src/personal-provider-config-repository.ts`: `read`, `update`, `#pollOnce` |
| Config-layer forwarding and Registry publishing       | `packages/provider/src/config-service.ts`, `packages/provider/src/registry-service.ts`             |
| In-process queuing and file lock budget               | `packages/shared/src/node/privateFilePersistence.ts`: `withFileLock`                               |
| Cross-process ownership verification and release      | `packages/shared/src/node/atomicFileLock.ts`: `acquireFileLock`                                    |
| TabStore and persistence listener                     | `packages/ui/src/store/tabStore.ts`, `packages/ui/src/hooks/useTabPersistence.ts`                  |
| Workspace serialization fields                        | `packages/ui/src/root/remoteWorkspaceSessionPersistence.ts`: `buildRemoteWorkspacePersistPatch`    |
| Setting update and actual disk writing                | `packages/services/src/setting/settingService.ts`: `update`, `writeSettings`                       |

Key location points within the original attachments are below, line numbers counted after decoding the original files, without any user configuration body:

| File                                    | Line                       | Content                                                                |
| --------------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `logs/2026-09-13.log`                   | 11184, 11187               | First poll lock fault and subsequent read degradation                  |
| `logs/2026-09-13.log`                   | 11965                      | `EPERM` for creating lock directory                                    |
| `logs/2026-09-13.log`                   | 14186, 14189               | 16.626s setting save phase                                             |
| `logs/2026-09-13.log`                   | 14652, 16404, 23497, 23872 | Subsequent startups reloaded normal config                             |
| `logs/2026-09-13.log`                   | 22729, 22733, 22734, 22735 | Minimize, 12.314s save, and concurrent Provider lock alert             |
| `.zcode/cli/log/zcode-2026-09-13.jsonl` | 5216, 5221, 5226           | Three subsequent messages failed execution due to `provider_not_found` |

A small number of naked anonymized placeholders in the CLI export logs caused JSON parsing failures; during the investigation, placeholders were normalized in memory before reading. Original files were not modified, nor was this used as evidence of file corruption. Complete user logs are not included in this report's archive; subsequent access should be through feedback ticket attachments.
