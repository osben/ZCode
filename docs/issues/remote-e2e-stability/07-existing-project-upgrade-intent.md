# Missing Authentication, Upgrade and Reinstall Handoff while Connecting an Original Project

Status: done

## 2026-10-11 Current Project Entry Regression

Business baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test build. In batch `r3-server-20261011101534847-c8a52a`, `version-snapshot-failure-required` completed a real SSH first install, A/B project creation and the install of the old-version metadata fixture. Clicking "连接" (connect) in the original project menu did not open the wizard; the page stayed on "需要处理 / 重新连接" (needs action / reconnect) and the remote ended at `3.14.0`.

- The run log confirms `remote-projects.connectHost` returned `SourceServerUpgradeRequiredError`: `Source Server 3.14.0 must be upgraded to at least 3.15.1`.
- The snapshot fault fixture intercepts reads only while the wizard exists; all 299 runtime samples had zero requests. This failure happened before the upgrade-intent handoff, so it cannot be attributed to the recovery logic after a snapshot rejection, and that fault branch cannot be claimed as covered.
- The project connection action in the current `packages/ui/src/project-sidebar/index.tsx` calls `remoteService.connectHost` directly and does not use the wizard upgrade handoff used before when restoring the original project. This call chain matches the run error above.
- Evidence is under `packages/desktop/.e2e-artifacts/r3-server-20261011101534847-c8a52a-version-snapshot-failure-required/`: `version-policy.json`, `test-results.ndjson`, the failure recording and the `logs/desktop` logs.

The full batch `r3-server-20261011105317614-4a6780` reproduced it again: `manual-required` failed at 397.3 seconds, `snapshot-failure-required` at 213.9 seconds. Both had `finalInstalledVersion` still `3.14.0` and neither got `restoredProjects`. The test also had an outdated assertion hard-coding the post-upgrade version `3.15.0`, now changed to this round's real first-install version; these two failures happened in the recovery wait stage and had not reached that version assertion, so they cannot be attributed to a false alarm from hard-coding.

This round recorded only the business regression, kept the failing assertions, and modified no business implementation. The ordinary manual update variant in the full queue still needs an independent re-check; the old-version fixes and pass records below are kept and are not pass evidence for the current baseline.

In batch `r3-server-20261011125749338-152f05` of test patch 07 on the same baseline, `serverupdate` (213.3 seconds) and `serverupdate-force` (226.7 seconds) also stopped at "the recovery entry offers no update action". These two same-version different-SHA cases did not reach the running-task forced-update confirmation, so they cannot be counted as covering the guard. The original assertions and independent targets are kept; the later cancel/force branches still need verification once the business handoff is restored.

`version-snapshot-failure-required` in the same batch failed after 225.7 seconds, with an original first-install version of `3.15.1` and `3.14.0` at the end of the fault, with no `restoredProjects` or `snapshotFailure` result. This is a block before the upgrade handoff; the later assertions of snapshot rejection and "retry updates only once" were not reached. `manual-required` in that batch failed after 398.4 seconds and also ended at `3.14.0` with no restored projects.

## Recovery after a Background Update Still Awaiting Triage

In the same full batch, the remote of `automatic-required` ended at `3.15.1`, unlike the manual branch which did not update. The run log records `source-server-management.updateSource OK (64480.1ms)`; afterwards only the ready ACK of one Source connection appeared, with no workspace-context-bound of the original A/B. The snapshot waiting for B to recover still kept the active identity/path but had no matching tab or remoteSessionId, and failed after 382.8 seconds.

This branch cannot be recorded as "the upgrade did not run", and a missing row in the navigation cache alone cannot assert a physical connection failure. The contract of automatic recovery of the original project is kept; further triage needs to combine the Source attachment with the project-navigation owner. `optional` recovered A/B and the remote stayed at `3.16.0`. After the test added async waiting, the patch 07 re-check still lacked the update hint, with A/B recovering normally; this is recorded separately as [optional update notice missing](21-optional-update-notice-missing.md), to avoid mixing it with the original-project upgrade/recovery failure.

`automatic-required` of test patch 07 failed again after 395.2 seconds: `finalInstalledVersion=3.15.1` but no `restoredProjects`. Unlike the manual branch of the same batch that kept `3.14.0`, project recovery after the background update completes still needs a separate fix; adding the manual-upgrade wizard handoff does not justify claiming that all recovery is done.

## Reinstall Entry after Uninstall on the Same Baseline

`uninstall` in the full batch `r3-server-20261011105317614-4a6780` also did not reach the install confirmation of the original project. `uninstall.json` records that the official CLI's two DELETE confirmations completed: `current.json`/releases were cleared and the original installationId, config, history and the user data sentinel were kept. The original task entered the offline-retained state, and after clicking the project's "连接" there was no "安装并继续" (install and continue) wizard within 30 seconds. The last frame of the failure video keeps the original message, the page shows "需要处理 / 重新连接", the sidebar project is still offline and no install confirmation appeared.

This is an observed missing reinstall handoff; it cannot be asserted to have exactly the same root cause as the upgrade branch merely from a similar UI. `remote-projects.connectHost OK (32.3ms)` in the run log does not prove the reinstall completed. The targeted re-run `r3-server-20261011123601821-eca14c` confirmed that after the failure `current=none`, releases are empty, the original tab's remoteSessionId is null, the project is offline and the dialog is null; no silent reinstall happened. Installing from the new-device entry to bypass the original-project contract is not adopted. Evidence directory: `packages/desktop/.e2e-artifacts/r3-server-20261011105317614-4a6780-uninstall/`.

## Original Project Without Credentials Did Not Enter the Authentication Wizard

`projectnavigation` in patch 08, batch `r3-server-20261011143037600-31012b`, passed the checks of flat offline projects, timeline switching, device labels, the project menu and the retired remote projectless entry. The fixture deliberately saves no SSH password; after clicking connect in the project menu the Host returned `Connection Profile requires interactive credentials`, but no authentication wizard appeared within 20 seconds, and the whole case failed at 86.5 seconds.

This is a missing handoff when credentials are absent, not lost credentials: the fixture never saved a password. The later assertions of cross-device form isolation and retaining the existing download method were not reached. The current project action path that calls connectHost directly should continue to hand over to the existing authentication flow, rather than only showing the user a failure they cannot handle. The business implementation was not modified at that time.

## Spec and Original Failure Behavior

The Feishu desktop SSH guide's "remote version update" and the main spec [§6.3](../../architecture/r3-source-server-remote-architecture.md#63-版本兼容与远端更新d10) require that an explicit manual connection starts one protected update automatically, and continues the original operation when no task is running. The original-project entry on the original test baseline opened the correct "更新远端" page but did not start an update automatically.

## Run Evidence

- Business baseline `a13999a28927f629d0c64080a5096cf8b4f23bae`.
- `conversation-session-ssh-remote-version-policy.test.ts`, `manual-required`.
- Batches `r3-server-20261009223735233-3b63ee` and `r3-server-20261009234650716-227ddc`.
- The independent target simulated Server 3.14.0 with the version-metadata variant of this round's full runtime; the CLI recorded that the daemon runtime converged to 3.14.0. A version string was not used to pose as an old business implementation.
- A/B were open with no running task; clicking connect on the original project B, the Host reported `Source Server 3.14.0 must be upgraded to at least 3.15.0`.
- The original project and directory intent were kept and the wizard showed "更新远端", but after waiting 180 seconds B's session was still empty. The Desktop log had no `source-server-management.updateSource` triggered by this operation; after the re-run `finalInstalledVersion` was still 3.14.0.

## Judgment and Boundary

The original test kept this as a difference between the original-project entry and the automatic-update contract; the root cause was verified in the next section. The "automatic update" assertion is not turned green by adding a click on "更新远端" in the case. The original regression round changed no business code. Waiting in the background for the user to update and confirming a forced update both have independent passing evidence and do not mean this original-project automatic update branch passes.

## Root Cause and Fix (2026-10-10)

Fix start `6ea1a0e30e8c62c278cb7c948ea936f8ff5b7704`. The wizard, project entry, update action and Host compatibility check code equal the original business baseline. `requestRemoteProjectConnection` hands an already-completed connection failure to the wizard as `initialFailure`; `acceptInitialFailure` only sets the error and the update button and returns, bypassing the automatic update logic that already exists in the exception branch of `startRemoteConnection`. Both guide version 41 and main spec §6.3 state that a manual connection updates automatically; the rule that an ordinary connection failure does not retry automatically does not cancel this upgrade contract.

A real dispatcher + Hook probe reproduced it: with the same SSH Profile and upgrade snapshot, the ordinary wizard calls `updateSource(force:false)` once automatically while the original-project handoff calls it zero times; clicking the update button again can continue the original directory. This boundary used simulated service I/O; the error, screenshots and unrecovered-session results of the historical real SSH runs are checked separately and the probe does not stand in for remote install success evidence.

The fix converges the must-update orchestration into the wizard's same function; both the original-project handoff and ordinary connection errors read the Host's latest snapshot and run one protected update automatically only for a remote required state. It keeps the running-task guard, the explicit force confirmation, the original directory intent and the existing epoch; results after cancel or an intent change do not continue the old connection, a failure keeps the action entry, and an incompatible state after the update does not loop. An over-old local app, ordinary failure and background recovery add no automatic update.

```text
Original-project connection failure / ordinary wizard connection failure
  -> same wizard intent -> Host snapshot confirms remote required -> updateSource(force=false)
  -> running-task guard: wait for the user to confirm; success: continue the original directory connection once only
  -> cancel / change intent: the old epoch is invalidated, the old project is not restored
```

Verification record:

- 9 new real dispatcher / Hook regressions: before the fix 7 failed and 2 normal controls passed; after the fix the related two files' 27 tests all pass. Covers first-reported upgrade, existing upgrade-required state, running-task cancel/confirm, late results after update cancel, update failure, still incompatible after update, collapse recovery, over-old local app and ordinary failure.
- `pnpm test:unit:affected --base 6ea1a0e30e8c62c278cb7c948ea936f8ff5b7704`: 370 Vitest files / 4379 cases and 28 Node audit cases pass; the full unit suite was not run.
- Root type check, E2E type check, lint, architecture, fixture, changed-code format and open-source terminology checks pass; lint keeps 81 pre-existing warnings.
- macOS Electron → independent Linux arm64 SSH container, `desktop-e2e-20261010-version-fix-manual-required-r2` **1/1 PASS**. Only clicking connect on the original project B, the real `updateSource` succeeded, the remote updated from the fixture's 3.14.0 back to 3.15.0, and A/B kept their original identity and directory and got new sessions. The two session-generation assertions and artifacts were added, and the original 180-second recovery assertion is kept. The wizard source digest in the `fresh-stable` build evidence equals the fix tree.
- The first local round had no outer budget with the server harness and was cut off by the WDIO default 120 seconds in fixture preparation before the original-project reconnect. The re-run supplied the outer 15-minute budget by the existing `ZCODE_E2E_MANUAL_REVIEW_HOLD_MS=780000` configuration, equal to the spec's own budget; no recovery assertion was relaxed and no business retry added.
- The three independent variants `desktop-e2e-20261010-version-fix-{automatic-required,optional,controller-required}-r2` all **1/1 PASS**: background wait first, update after the click and recovery of A/B; an optional version stays at 3.16.0, both projects recover and "稍后" (later) takes effect across reopening Settings; an over-old local app only prompts to upgrade the local app, and the remote archive is unchanged. The last two showed no Desktop management service update-success log, and the remote version/artifacts stayed. The raw state of the three reused builds stays `unverified-reused-build`; all 5282 artifact digests were additionally compared one by one with the `fresh-stable` build above, completely identical, and the check result is saved as `version-fix-verification.json` in each run.

The four variants of this round keep `manual-review/pending` with no manual promotion or CI admission. The version input is still a metadata variant of the full current runtime and does not claim to verify a real 3.14.0 old business implementation. Running-task cancel/force confirmation and late results are covered by real Hook boundary tests, and the real SSH forced-update scenario with a running task was not run separately; native Windows/Linux desktop hosts and the whole mobile relay chain were not re-run. The fix only adjusts the wizard orchestration of explicit desktop connections and does not change the Host/protocol, data migration or the continuous/replayable authority; reverting this commit restores the previous behavior of waiting buttons.

## Explicit Recovery When the Upgrade Snapshot Fails (2026-10-10)

After `dcf125265e` introduced the automatic handoff, if the newly added snapshot read fails it only clears `upgradeProfileId` and keeps the old upgrade error; the "更新远端" button returns directly because it has no Profile. The fix clears the old upgrade error in the same exception branch, shows the real read exception and the existing "重试" (retry), and lets the user restart the connection and upgrade check of the original route/directory. It keeps epoch isolation, does not use an old snapshot to update automatically, and adds no background retry.

- Two failing regressions for the ordinary connection and the original-project handoff were added first, both failing before the fix; a late snapshot exception after cancel is the control. After the fix the three plus the original Hook cases pass **23/23**.
- Affected verification (start `dcf125265e55416eed962a342250b592c0f46461`): **370 Vitest files / 4382 cases and 28 Node audit cases pass**; the inventory audit after the final E2E helper adjustment passes **9/9**. Type check, E2E type check, lint, architecture and fixture checks pass; lint keeps 81 pre-existing warnings.
- `r3-server-snapshot-fix-20261010-r2` **1/1 PASS**: the desktop was rebuilt and, on a real SSH upgrade fixture, a short snapshot read fault was injected; the wizard shows the actual error details and "重试", no update happens during the failure, and after clicking it updates exactly once, A/B keep original identity and directory and get new sessions, and the final remote version is 3.15.0. `version-policy.json` records the number of rejected reads (2 this round), the buttons, update call count and recovery results; `snapshot-failure.png` keeps the failure screen.
- The first round's test only rejected the first parameterless snapshot request, hit a concurrent background read and did not cover the wizard, so it is not evidence that the fix works. The test now keeps the short read fault until the wizard confirms the failure, then restores reading and verifies the user's retry; no business plan was changed and no recovery assertion relaxed.

This verification still uses the version-metadata variant of the current runtime and does not prove a real old business implementation; native Windows/Linux desktop hosts and the mobile relay were not re-run. The phone does not use this desktop explicit-connection wizard, and the Host/protocol and recovery owner are unchanged.

## 2026-10-12 Current Baseline Re-check and Fix Boundary

Fix start `07c35ed00085b9bb105d07633488951ff02032c2`. The project menu in the original log still called remoteProjectService.connectHost directly, whereas the current RPN-06/§2.2 requires handing over to the single wizard when interaction is needed and keeping the directory. The existing Root dispatcher/wizard already handled credentials, protected update and install confirmation, and the menu was not wired to it; merely replacing the callback was not enough either: the new version only restores the active tab, and the Root's old entry returns directly for an unloaded tab/history entry. A real Root hook regression for a project without a tab confirmed this boundary: authentication/upgrade/install handoffs and the normal device connection were not executed.

```text
Loaded project → Root in-place reconnect → waits for handling → single wizard → original directory
Unloaded saved project → Host member connectHost → waits for handling → same wizard → original directory
                                   └─ ordinary success only restores the device, creating no navigation tab
```

Recommended fix: the desktop project menu calls the existing Root reconnect entry; with no tab, Root resolves the target from the local member directory, reusing the existing dispatcher and connectHost. Re-read the member before the handoff; late results after removal/replacement do not open an old wizard. Connection state, credentials and the physical connection stay with the Host; the Renderer tab restore does not become the authority of the project entry. Non-desktop paths keep using the original Host connection and no mobile wizard capability is added.

The background-update case is also checked against F5: a cold start restores only the active project, and another project in the old compatible list should open on demand. An unloaded A tab must not be treated as an update failure; a manual upgrade with existing A/B attachments running keeps its recovery assertion.

### First Run and Further Evidence

Batch `r3-server-20261012022109986-c4ed79` used the current baseline plus the project entry fix and gave 5 PASS / 2 FAIL: serverupdate 271.8 seconds, serverupdate-force 268.9 seconds, manual-required 260.0 seconds, snapshot-failure-required 263.3 seconds, automatic-required 270.1 seconds all passed. The latter two still failed: projectnavigation had no authentication wizard; uninstall clicked the install confirmation but then received source-server-install-required. Reaching the install confirmation is not taken as reinstall success.

Newly found authentication root cause: SourceServerDirectory.resolveProfileTarget threw an ordinary Error when credentials were missing, losing the existing public credentials-required code; a real Directory regression failed first, then passed after adding the code at the error-producing boundary. Root's text classification is not extended to guess the authentication reason. The real Flow hook for the install confirmation has verified that confirmSourceServerInstall=true is sent out and the old error cleared; the next round records only the confirmation flag and the return result at the Main IPC (no target or credentials) to keep locating the remaining reinstall failure.

### Reinstall Root-Cause Re-check: the New Recovery Cycle Read a Stale Terminal Failure

In round four Main confirmed confirmSourceServerInstall=true, ruling out that UI/Main lost the confirmation. Round six's Registry recorded route=null at confirmation, while the same Source still had a terminal owner of another route with recovery=false, failure=true; only afterwards did the new connection enter the canonical Source ownership. The earlier synthetic probe of a recovering same route did not cover the field case, so the install special case and the Manager-authorized admission candidate were withdrawn and are not part of the final implementation.

Field case: project navigation uses a metadata route without a passphrase; the user-confirmed connection loaded the passphrase and got a different route key but still belongs to the same Source after the handshake. When Manager republishes the physical connection, the old terminal owner starts attaching workspaces asynchronously, but recoveryFailure is cleared only after all attachments end, and recoveryReady was already cleared at the terminal. The new route joining the canonical owner in the meantime directly throws the previous install-waiting error, although the new install connection has been established.

```text
Old owner: terminal + old failure + no recoveryReady
New physical connection → logical attach (async) → new route joins → wrongly reads the old failure
Fix: new physical connection → new recoveryReady, clear old failure → logical attach → join waits for the new cycle's result
```

The real Registry regression used the same agent/password route keys as the field, the same Source and a controlled workspace-preparation barrier, and before the fix produced the same Remote connection recovery exhausted error. The final fix calls the existing beginRecovery only when a terminal owner receives a new physical reconnect and marks a new recovering cycle; no install special case, Manager flight field, retry or timeout is added. The regression plus the adjacent Registry/Manager two files pass 120 tests. Batch `r3-server-20261012042036306-3218d0` of the final patch passed the real reinstall (187.4 seconds), the recovery guard (177.4 seconds) and cold-start reconnect (187.1 seconds). The source manifest SHA-256 is `3da756d09a6a91969782149c7f1d177124e49e5def287fcfde14ed11d56cd85d`. The reinstall evidence confirms the install ID, Profile, project identity, config sentinel and user data are kept; the session was replaced, the original task can continue, and the Host process set did not grow.

### Final Server Acceptance

Batch `r3-server-20261012042909750-5eed5a` reused the same source manifest and the verified build `beb4f93a0a86d3c6f4d0fab7d21188f5838fd7a07248f9eb7162e7d0db5551ae`, and all six passed. Together with the previous batch's three, they cover this problem's seven items and the two adjacent recovery/cold-start items; PASS of different patches is not merged.

| Case                              | Result / duration |
| --------------------------------- | ----------------- |
| serverupdate                      | PASS / 256.9 s    |
| serverupdate-force                | PASS / 255.3 s    |
| uninstall                         | PASS / 187.4 s    |
| version-manual-required           | PASS / 273.6 s    |
| version-snapshot-failure-required | PASS / 231.5 s    |
| version-automatic-required        | PASS / 237.5 s    |
| projectnavigation                 | PASS / 73.1 s     |
| recov                             | PASS / 177.4 s    |
| coldreconnect                     | PASS / 187.1 s    |

Cancelling the forced update keeps the original SHA/Core; the replacement happens only after the forced update is confirmed. After the snapshot fault is restored, the update is called exactly once; a manual upgrade with a running task restores both original directories A/B; a cold-start automatic upgrade restores active B by F5, and A keeps its entry and opens on demand. The authentication verification saves a project that enters the wizard without an existing tab, and switching devices leaks neither the previous device's password nor its download method. The final code and tests match the server source manifest file by file; only the acceptance documentation was added afterwards.

### Local Verification and Impact Boundary

- `pnpm test:unit:affected --base 07c35ed00085b9bb105d07633488951ff02032c2`: 442 Vitest files, 5174 cases and 70 Node checks pass; the full unit suite was not run. An earlier round's unchanged Web build test failed on a concurrent timeout, passed 45 tests in an independent re-check, and the final affected scope passed entirely, with no timeout or assertion changed.
- Type check, lint and the architecture check pass; lint has 208 pre-existing warnings, 0 errors, and the architecture 0 violations.
- The fixture contract checks of the four changed E2E pass; server-update keeps the existing reminder that the upgrade marker is not covered by the matcher.
- Version-policy scenarios use a version-metadata fixture of the current runtime and cannot prove data migration of a real old program. Server runs cover Linux Electron with real SSH/Docker; native Windows/macOS and physical phones were not re-verified. Non-desktop connections still go through the original Host, and the Direct Server connection and error semantics are kept by the new regressions.
- There is no change to storage format, credential migration or protocol fields. Reverting this commit returns to the original implementation; no user data rollback is needed.
