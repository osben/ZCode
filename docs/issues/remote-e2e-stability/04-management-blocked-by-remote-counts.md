# Device Management Page Cannot Show Existing Devices and the Disconnect Entry while a Remote RPC Stalls

Status: fixed; real SSH E2E verified (2026-09-26)

## Expected and Actual

While a remote request has not returned, the user still needs to disconnect manually through the saved device record. On the branch at that time, entering the "远程连接" (remote connection) Settings page showed only connection preferences and the new-connection button; the existing device list was empty and an existing Source could not be disconnected.

This blocked the real R3A-PRV-13 acceptance "disconnect while the sync has not returned"; releasing the reply and then clicking disconnect, or bypassing the UI to call an internal command, must not be used to judge this path as passing.

## Actual Evidence

- Business baseline: `54ece08f23f79ae54aea1f51e0d941497d627392`, no business implementation modified.
- Batch: `r3-server-20260924172343371-384821`, test source manifest `0fa28903814184a7dedf86882691a963d75096178722f4369add693a7f858462`.
- The Source had really deleted the named Provider; the Desktop product SSH reply was held by the proxy for 11772 bytes, and the model replay tunnel and the control probe used independent direct connections.
- Main's sync result count was 7 both before and after the commit, with this result not yet received; the original remoteSessionId was still bound.
- After opening device management, waiting 30 seconds did not find the "断开" (disconnect) entry of the saved device, and the test failed.
- The video frame about 20 seconds before the failure (`packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-management-stalled.png`) shows an empty device area. That frame precedes the cleanup action and is not the empty state after `clearAppData`.
- The raw video (`packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-failure-smoke-01.webm`) and the controlled injection facts (`packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-failure-smoke-01-facts.json`) keep the failure process.
- The independent batch `r3-server-20260924181553216-617c6a` (test manifest `dd76d5be828b2dc4014c4fafc7b4c44630a963ecb1ad7b02ffeb7068d634964b`) first proved that existing devices and the disconnect button are available on a healthy link. It then held 17200 bytes, Main's result count stayed 18, and it failed again after 31.247 seconds. The failure scene confirmed the local Source record still existed while the page showed only connection preferences and new connection.
- The healthy-link page (`packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-management-before-hold.png`) and the page after the stall (`packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-management-pending-failure.png`) were both captured directly by the case before cleanup; the complete facts (`packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-failure-smoke-03-facts.json`) also prove that a PRV-12 write failure only warns, local success feedback, connection retention and a second save after recovery all completed.

## Code Location

1. `getSnapshot` in `packages/desktop/src/host/sourceServerManagementService.ts` first reads the local directory, then awaits `readMigrationCounts`, and only then returns the whole snapshot.
2. `readMigrationCounts` awaits two remote RPCs, `getFailedPathCount()` and `getAbandonedPathCount()`, for an online Source; this read has neither an independent deadline nor a degraded result.
3. The initial snapshot in `packages/ui/src/hooks/useSourceServerManagementSnapshot.ts` is null and data shows only after the whole `getSnapshot()` completes.
4. The existing devices and disconnect buttons of `SourceServerManagementPanel` are generated from the snapshot, so they were blocked together with the unfinished migration-statistics request.

This call chain matches the measured empty list; only one Source was measured and the impact range with several Sources was not verified.

## Fix Boundary and Acceptance

The local directory and connection state should stay readable, and unavailable remote migration statistics should not block manual disconnect. The statistics state must express explicitly that no data was obtained and must not be faked as zero. After the fix, re-run the controlled reply case, keep the precondition that the Source has committed while Main has not received the result, then disconnect through the real UI and verify release of the old RPC, offline edits and the latest configuration after reconnecting.

## Root-Cause Fix and Verification (2026-09-26)

After the user explicitly authorized the root-cause fix, the wait of `getSnapshot()` on remote statistics was removed. The Host management service first returns the consistent snapshot of the local Directory and Manager; the [statistics projection](../../../packages/desktop/src/host/sourceServerMigrationCounts.ts) reads counts independently per current physical connection, and `loading` / `unavailable` / `requires-connection` carry no fake zero. Only `available` contains real counts validated by schema, and the top-level total sums only these known items.

```text
Directory / Manager → local consistent snapshot → device list and disconnect button
current connection's statistics RPC → completes independently → check the connection and projection are still valid → generation / directory event → fill in statistics
```

At most one group of statistics requests is in flight per connection; when one fails the group still waits for the other to settle. In-flight invalidations are merged into one later read, so consecutive directory events do not pile up pending requests. Old results after a generation change, deletion or dispose are not published; directory changes and migration retry/abandon invalidate the counts. Explicitly entering or refreshing the page requests updated statistics, whereas event-triggered refreshes read only the existing projection, avoiding feedback polling. This optional request parameter and the returned states are validated strictly in the shared contract.

The fix changes neither Provider apply, identity persistence, the remote Server/Agent protocol, nor the desktop continuous / mobile replayable routing. The statistics projection exists only in Host memory, adding no persisted format or migration; rolling back needs reverting the Host implementation, the shared management contract and the UI hook together, which would restore the original remote-statistics blocking risk.

Verification evidence:

- A valid-UUID fixture on the old management service failed all 4 regressions; after the fix the related 10 test files total 121 passing. Covers a slow Source not blocking another Source, manual disconnect, read merging, error states, explicit refresh, in-flight refresh merging, connection generation, Source removal, dispose and late results. The earlier failures caused by an invalid-UUID fixture do not count as root-cause evidence.
- Type check, E2E type check and the architecture check pass; lint has 0 errors and 65 pre-existing warnings.
- The final version ran on business baseline `362a5dd23304d1aed78d8e961bc12e3205123909` plus the fix patch, input manifest SHA-256 `bd8b2ccd0a86748a035cb2c7794df41ce3d25512c616035141158c529aa9c22c`. `provisioning` in batches `r3-server-20260926013327721-60bf25`, `r3-server-20260926014117100-b67658` and `r3-server-20260926014430621-fefb7b` all PASS, taking about 215, 187 and 184 seconds. The first batch also verified `devicerow` and `uninstall`, both PASS.
- All three rounds confirmed that the Source had committed, Main's result count stayed unchanged and the proxy still held about 17 KB of the reply; the disconnect was then done through the original UI. The original case changed no assertion or released the reply early; offline edits not delivered, two edits synced after reconnecting, A/B workspace recovery and PRV-12 write-failure recovery all completed.

The real E2E covers two workspaces of one Source; mutual isolation of several Sources is proven by unit tests of the real management service. After a logical disconnect the proxy may still forward previously buffered encrypted SSH bytes, so this must not be described as "all transport bytes are discarded"; the lifecycle contract of rejecting old RPCs is covered separately by the real connection test in `serverRemoteConnectionLifecycle.test.ts`. This fix does not claim other business problems or native editor platform coverage as complete.
