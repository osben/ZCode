# R3 Remote Connection Full Rerun Record (2026-09-10 ~ 09-11)

Full history: `git show b8876e8b:docs/testing/r3-remote-full-rerun-2026-09-10.md`

> Background: after the R3 merge there were many code changes, so the remote-connection e2e was rerun in full (49 cases: standard 37 + special 10 + soak 2).
> Principle: **environment-caused false failures must be fixed away, real product defects must not be hidden, and conversely product defects must not be misattributed to the tests.**
> Detailed per-round forensics are in `.e2e-artifacts/r3-rerun-20260910/ANALYSIS.md` (sections 1-61; this document is its redacted summary).

## Execution

- Unified runner (`run.mjs`): one container + one home per case, a FAIL automatically reruns once; a failure keeps the container and home (`docker stop` preserves the filesystem scene), a success cleans up.
- Self-healing controller (`recover-all.sh`): idempotent queue polling; completion = console marker `[rec] <case> exit=`. Note `exit=` is the runner process exit code (always 0), so **PASS/FAIL must be read from `status` in results.json**; this trap once made the deleter misjudge.
- Environment gate (mem_gate, 0911 corrected): open a new case only when memory pressure level is normal and reclaimable headroom is at least 3000MB (swap used is a monotonically non-decreasing cold-page counter, logged but not a gate); 5 memory-killer events occurred during the test and the controller resumes from a breakpoint.
- All credentials are injected through environment variables; passwords are redacted (redactText/redactDir); this document contains no key material.

## Result Summary (historical final state, closed 0911 12:48)

| Batch                                | Total  | PASS   | FAIL                         | BLOCKED |
| ------------------------------------ | ------ | ------ | ---------------------------- | ------- |
| standard (single-container replay)   | 37     | 34     | 3                            | 0       |
| special (docker/live/systemd/mobile) | 10     | 7      | 3 (one counted as BLOCKED)   | 1       |
| soak (reconnect/dual)                | 2      | 2      | 0                            | 0       |
| **Total**                            | **49** | **43** | **6** (one actually BLOCKED) | **1**   |

> The 6 FAILs: r3-install-faults / r3-live-bigmodel-team (= BLOCKED) / r3-provisioning-gui / r3-settings-scopes / r3-terminal / ssh-remote-project-conversation-scope. The historical final state is kept; after review 2 are product defects confirmed, 2 are test defects (r3-install-faults, ssh-remote-project-conversation-scope, both rerun PASS later), 1 is a product suspect (terminal), 1 is an expired environment material (BLOCKED).

Soak closed: soak-reconnect 50 rounds all green; soak-dual 56 rounds (5-minute final round) all green: desktop/phone bidirectional echo incremental reconciliation 0 missing, 18 network-recovery rounds all passed, no leaks. **Zero defects on the product side; all root causes were test-code defects** (DOM virtualization reconciliation mode fixed, section 55).

## FAIL Root-cause Classification

### 1. Product defects (confirmed, FAIL kept as an issue)

| case                | Defect                                                                                                                                             | Evidence                                                       | Section |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| r3-provisioning-gui | A disconnect during sync did not reject the old RPC, and the Provisioning lane blocked the reconnect attachment; fixed, full rerun PASS 0911 16:15 | Real connection probe and GUI rerun (see the fix record below) | 19/25   |
| r3-settings-scopes  | Creating an agent with scope "User" wrote the file to the remote home (ownership ambiguity / wrong write)                                          | The kept container proved the file on the remote               | 42      |

> Later state: the original `r3-settings-scopes` defect was real and its GUI regression PASSed after the 2026-09-11 fix (see the review records below). The table above and the 49-case summary keep the historical basis.

### 2. Product defects (suspected, issue opened, FAIL kept)

| case                                  | Suspicion                                                                                                                                                                                                                                                                                                                                                                                                                     | Section  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| r3-terminal                           | The remote terminal PTY data stream is intermittent (45s of zero output / 32s of complete input-echo failure, one kind per round); the SSH layer is excluded; suspect commits 6a1de7485c / 9b56031ac2 / 13c82d12e1                                                                                                                                                                                                            | 57       |
| r3-uninstall (guidance)               | After uninstall the wizard error tells the user to «请在连接管理确认身份换代» (confirm the identity generation in connection management), while connection management only has a «重新安装并连接» (reinstall and connect) entry: **guidance copy does not match the actual entry**                                                                                                                                            | 56       |
| r3-uninstall (silent reconnect group) | After uninstall all three UI reconnect paths lock up silently: (1) the first-connect generation error guidance is invalid; (2) the device row attach is silent (section 52); (3) after clicking «重新安装并连接» (reinstall and connect) a directory quick-pick panel appears, entries stay disabled, and the main side shows zero connection actions for 10 min (section 58 forensics: main process blank 12:05:40-12:15:52) | 52/53/58 |

### 3. BLOCKED (environment material expired, not a product problem)

| case                  | Reason                           | Handling                                              |
| --------------------- | -------------------------------- | ----------------------------------------------------- |
| r3-live-bigmodel-team | live credential material expired | Log in to BigModel again in the local app, then rerun |

### 4. Test defects (fixed, all closed PASS)

| case                                  | Original defect                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                  | Status                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| r3-install-faults                     | The fault corrupted the x64 package while the target was ARM64; B reused an online session and never entered validation                                                                                                                                  | Pick the package per target architecture, restore in finally; B disconnects explicitly and switches back to a local draft                                                            | **PASS (0911 14:43 rerun)** |
| ssh-remote-project-conversation-scope | The first conversation connection missed the install confirmation embedded in the wizard; the original log timed out before the project scenario ran, so the product attribution of sections 26/40 is withdrawn                                          | Call the public waitForSSHDirectoryStep first, then keep the original conversation/project isolation assertions                                                                      | **PASS (0911 16:32 rerun)** |
| r3-uninstall (business assertions)    | A fresh container has no first install, so the if branch is never entered; the identity-generation contract did not follow the product flow; the seven-segment card hit the directory quick-pick panel (silent product defect)                           | Eight-segment version: first install -> uninstall reconciliation -> silent forensics sampling -> remove all connections -> fresh first-connect reinstall -> installationId assertion | **PASS (round 36)**         |
| r3-subagent                           | Agent process cwd filter basis (cwd is actually the daemon home /home/dev, section 59 forensics)                                                                                                                                                         | Assertion changed to args-match existence (>=1 and <=2), cwd kept as an observed fact                                                                                                | **PASS (round 37)**         |
| r3-ui-pairwise                        | Same install-confirmation hang as section 32 (the boundary catch swallowed the error)                                                                                                                                                                    | Insert waitForSSHDirectoryStep before waitForSSHConversation                                                                                                                         | **PASS (round 38)**         |
| ssh-remote-provisioning-ready         | Same as section 32 (the 90s waitUntil only knew ConfirmDialog and missed the inline button) + section 60: the model-selection contract was removed as a whole by provider-refactor-m2 (b10e5e5d80), both local and remote now write provider_config.json | Insert waitForSSHDirectoryStep after submit; remote + local reconciliation changed to provider_config existence (content holds credentials, redacted and not read)                   | **PASS (round 42)**         |

## Test-side Lessons (methodology)

1. **spec validation**: esbuild single-file transpile does not validate cross-module exports (waitForWorkspaceApp incident, section 56); use `tsc --noEmit --ignoreConfig` + grep `TS2305|TS2724|does not provide`.
2. **wdio loader timing**: the worker reads spec/helper at start; a change made after the process started reads the old version, so after a spec change confirm the next wdio start is later than the write (section 55).
3. **DOM virtualization reconciliation**: full end-of-run reconciliation necessarily fails at high round counts; per-round incremental reconciliation (the just-sent marker must be at the window bottom) + wait-style echo (tolerating remount in network-cut rounds) is the correct pattern (section 55).
4. **Controller exit= trap**: the exit value of the completion marker is the runner process code, always 0; PASS/FAIL must be read from results.json (section 54 note).
5. **Deleter pattern**: wait for `[rec] <case> exit=` (use `until grep -q`; do not compare `grep -c` counts, because in zsh a zero match makes `$()` capture two lines and an integer comparison loops forever) -> sleep 5 -> read the results.json status -> delete the marker only on FAIL -> controller reschedules; leave PASS alone; delete the marker by **full rewrite** (open w + replace, same path same inode so tail monitoring is not lost; an in-place single-byte write with r+ seek was measured unreliable, section 59 note).
6. **Keep the FAIL scene**: wdio.conf `onComplete` used to delete the case home unconditionally; it now keeps it when `exitCode!==0 && ZCODE_E2E_KEEP_HOME_ON_FAIL=1` (section 47).
7. **ssh2 noise**: a REQUEST_FAILURE right after a keepalive ping is sshd refusing a global request, harmless, not a connection fault (section 57).

## Environment-side Fixes (false failures removed)

- mem_gate: pause polling when swap > 7500MB, removing chained memory-killer kills (5 times, sections 43/44).
- `docker exec -i` carries the CLI uninstall confirmation (stdin in chunks; the SSH exec channel swallows chunks that arrive early, section 51).
- x64 emulated containers start slowly: probe/install wait windows relaxed; the test directory moved for noexec environments (three install-environment cases).
- Failures in high-swap windows (19:0x / 01:5x) were all rerun and verified and are not used for characterization.

## Product-defect Issue List (suggested)

1. Silent remote entry must be verified per root cause: section 19 is confirmed and fixed as an unreleased low-level RPC blocking the Provisioning publish barrier; it can no longer be attributed to openRemoteConversationWorkspace. The product issue of sections 26/40 is withdrawn: the project scenario was never reached and the full rerun PASSed after the first-install confirmation test fix. Sections 52 and 53 keep their own evidence and are not merged by similar UI symptoms.
2. Post-uninstall silent UI reconnect path group: section 56 (guidance copy does not match entry) + section 58 (zero connection actions after clicking «重新安装并连接» (reinstall and connect), 10-min blank on the main side).
3. The "install failure silently hangs" issue is withdrawn: section 35 was refuted by the original success log (see the review below).
4. Scope ownership wrong write: section 42 ("User" scope written to the remote home).
5. Intermittent remote terminal PTY data stream: section 57 (suspected, with suspect commit list).

## r3-install-faults Review and Test Correction (2026-09-11)

Conclusion: the original "install failure silently hangs" was a misjudgment. The spec hardcoded corruption of the linux-x64 package while the runner used a linux/arm64 container; the log shows an intact uploaded ARM64 package, remote-connected, workspace-context-bound, and only then dialog-gone. The B device was the pre-fault installed control device, not a half-registered leftover; an exception in a telemetry batch cannot replace the connection result.

The corrected contract is in the BLD-04/06 supplement of `r3-remote-automation-case-matrix.md`: pick the package per remote architecture, restore in finally after injection, keep strict failure and install reconciliation assertions. A new real run found that B stays online after its first install and reuses the session, skipping package validation; the test now disconnects via the device menu, waits until the same identity is offline, then switches back to a local draft. **Full GUI E2E PASS on 2026-09-11 14:42-14:43 (Beijing time)**, test body 66.984s; the historical 49-case results keep their original records.

Verification: fixture regression and real resolver unit tests 14/14; focused TypeScript check, architecture:check (0 violations), oxfmt, lint (0 errors; 59 existing warnings) passed. `pnpm typecheck` and `pnpm --filter @zcode/desktop typecheck:e2e` ran but are blocked by 7 existing ProviderAccessConfig/nullability type errors in `r3-docker-transport.test.ts:72-74` and `r3-live-zapi.test.ts:61-64`, which were not modified. New evidence: `packages/desktop/.e2e-artifacts/r3-install-faults-fix-final-20260911/cases/r3-install-faults/`. All four A faults gave error/none/null; the B fault reported an explicit error and the SHA was unchanged; after cancel none/null; all Host reconciliation shows a single Local Host. Scope: macOS arm64 Desktop -> two Linux arm64 containers; x64/Darwin package-selection normalization is covered by unit tests and no real GUI verification of those platforms is claimed. Only tests and docs changed; product remote/session state logic is unchanged.

## r3-settings-scopes Fix and Regression (2026-09-11)

The original section 42 was a real product defect: after choosing User in Subagents, the scope still inherited the path/identity of the active remote workspace, so user config was written to the remote home. The fix pins the base Host service of the ordinary User at the Subagents scope target; plugin initialization uses only an available local workspace; a User save refreshes the existing subagent context of the same service authority, so a remote activation or a missing workspace does not skip refreshing the local cache, and a not-yet-finished remote load during switching is protected. Remote Workspace and explicit Source User keep using their own services. Provider provisioning, Host topology and the desktop continuous / mobile replayable paths are unchanged.

Tests first observed 4 related failures, then verified the fix (the new refresh race also got a failing assertion first); the final related unit tests 107/107 cover User/remote same-path scope, offline and no-local-workspace, explicit Source injection and cross-authority cache isolation. The E2E selects the same-named workspace by identity and checks files on both local and remote; the conversation default on the remote is a workspace, and the wrong "pick the last default and call it remote User" basis is removed. The GUI entry of explicit Source User and read/write of other settings sections are outside this pass.

**Final real GUI E2E PASS on 2026-09-11 15:18-15:20 (Beijing time)**: independent home / Linux arm64 container, macOS arm64 Desktop rebuilt; the User file exists locally and the same-named remote file is empty, the conversation file exists only in the remote backing workspace, the project file only in the remote project, neither local user nor project has a same-named file for the remote project, and window Host reconciliation is unchanged. Verification: `pnpm architecture:check --changed` 0 violations; `pnpm lint` 0 errors, 59 existing warnings; changed-file oxfmt and diff check passed; `pnpm exec tsc -b packages/ui` and the focused E2E type check passed; `pnpm typecheck` and Desktop `typecheck:e2e` were blocked by the same 7 existing errors. Evidence: `packages/desktop/.e2e-artifacts/r3-settings-scopes-fix-final-20260911/`. Windows/Linux Desktop, phone and all theme combinations were not run; this UI change touches no styles or copy and other clients keep consuming the existing service injection.

## r3-provisioning-gui Root-cause Fix and Rerun (2026-09-11)

Conclusion: the original product defect was real and the full GUI E2E PASSes after the fix. The root cause is the physical-connection lifecycle of `ServerRemoteConnection`: closing only the socket/agent did not dispose the ChannelClient, so a disconnect during sync left the old RPC pending forever, the Main Environment lane could not finish, and later connections were blocked by the initialSync publish barrier; this case had not yet entered openRemoteConversationWorkspace.

The fix makes the connection the single owner of the RPC client and protocol and releases them idempotently on deliberate disconnect, socket close/error and handshake failure, reusing the existing sync-failure settling and re-online sync flow; no delay or retry is added and the first-sync barrier is not bypassed. Spec: "Physical connection close and sync request settling" in `../remote/provider-provisioning.md`.

Tests were falsified first and fixed after: 4 new real-network regressions (WebSocket/Duplex x deliberate disconnect/peer close) failed before and pass after, also covering a new Environment sync while the old reply has not returned, late replies, repeated release and calls after close. Connection, Source auto-recovery, Main attachment, phone shared-host/relay and low-level RPC tests total 179 passed.

The first full GUI run passed project/conversation recovery and latest-config sync, then exposed a test-precondition defect that the old fault had hidden: B-05 created a draft only after switching the Composer of task A to a temporary Provider and then deleted that Provider, so the A continued-send selection became invalid (`resumedModelConfig` provider/model/thought were empty). The test now creates the B-05 draft before switching the model and finally verifies A still holds its original model and thinking level. The deletion-complete criterion is limited to the provider navigation: a leftover name elsewhere on the page cannot overturn a deletion RPC and remote file reconciliation that already succeeded. All business assertions are kept.

**Full GUI PASS 2026-09-11 16:14-16:15 (Beijing time)**. Facts initialContainsSeeded, onlineSave, b05ExistingAgentRefresh, deletePropagated, offlineEditsNotSyncedWhileOffline, afterReconnectHasBothOfflineEdits all passed; project/conversation both recovered with different sessions, the original task selection was lifecycle model/disabled, and the continued send completed. Evidence: `packages/desktop/.e2e-artifacts/r3-provisioning-fix-verified-20260911/cases/r3-provisioning-gui/`. Verification: focused type checks for Host/Main and the new lifecycle tests passed; lint 0 errors (59 existing warnings), architecture 0 violations; `pnpm typecheck` and `typecheck:e2e` still blocked by the same 7 existing errors. Not rerun on a Windows/WSL real machine; the phone boundary is covered by shared-host/relay focused tests and no phone GUI was run.

Auto-recovery supplement: `r3-transport-loss` PASSed on the same fix build, covering A/B same-group session generation swap after a disconnect while running, the remote task continuing, and a permission block recovering across a disconnect and completing with the sentinel executed once. Its permissionDialogId samples before and after were null, so it cannot prove request-ID continuity.

## ssh-remote-project-conversation-scope Review and Test Correction (2026-09-11)

Conclusion: the product characterization "project clicking the conversation entry is silent" of sections 26/40 is withdrawn. The failure stacks of the original four run logs all stop at line 55 of the unmodified spec, i.e. the initial conversation first connect; the project and task "+" steps (lines 64-74) had not run. All 1201 polls of the last round show `dialogOpen=true`, contrary to the `false` description in section 40; an empty project history does not prove a project bind lost history.

The test's `waitForRemoteConversationTab` handled only the old ConfirmDialog and missed the «安装并继续» (install and continue) embedded in the SSH wizard. Running the original polling script from the historical log against the current real connection-step component confirmed that the confirm button was never clicked and the state stayed dialogOpen=true/tabs=[]; the public helper clicks in both the Chinese and English variants and the isolated probe passed 3/3. The fix calls the existing `waitForSSHDirectoryStep` after `connectSSHConversation` submits, handling the install/boundary confirmation, then runs the original conversation identity/session/activation assertions; the project/conversation independent-session and single-Host contract was not relaxed and no product code changed.

**Full GUI E2E PASS 2026-09-11 16:31-16:32 (Beijing time)**, test body 26.505s, no retry, fresh Linux arm64 container, independent home, Desktop rebuilt from the worktree based on `9267b534287a1248a32dfb03feeea0e9d3cf9fff`. The embedded install button and the wizard close are in the run log; afterwards the project and the new conversation attachment each completed bind, and the assertions for the original independent remoteSessionId, current active tab and Window Host unchanged all passed. Evidence: `packages/desktop/.e2e-artifacts/r3-project-conversation-fix-20260911/`. The historical app bundle was cleaned and its manifest recorded no SHA, so this pass proves only the worktree above. Verification: fixture check, focused E2E type check, oxfmt, architecture (0 violations), lint (0 errors, 59 existing warnings) passed; `pnpm typecheck` and `typecheck:e2e` still blocked by the same 7 existing errors. No Windows/Linux Desktop or phone GUI was run; only a test precondition was fixed, and the product implementation of desktop-continuous and phone shared-host/replayable is unchanged.
