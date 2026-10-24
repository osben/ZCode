# Desktop E2E Runtime Performance Spec

## Goal and measurement

This spec governs the Windows local full-run performance acceptance of the root `pnpm test:e2e:windows:sharded`. In the ordinary full scenario that entry fixes 10 shards; if native `--shard`, targeted, manual-review or capture is also enabled it drops to a single shard and the result is not a performance acceptance. The goal: without reducing default formal specs, cases, assertions or replay time-boundary semantics, the optimized full wall-clock time is at most 50% of the first baseline. The no-argument `pnpm test:e2e` is the stability-first single-shard correctness entry and carries no wall-clock acceptance.

Only the full parent runner `shard-manifest.json.wallDurationMs` produced by `pnpm test:e2e:windows:sharded` counts as total wall-clock. Per-shard `summary.json`, `lifecycle-events.ndjson` and `perf/webdriver-delete-session.ndjson` are for attribution. Results from targeted specs, reused old builds, early exit after failure, or a changed spec scope cannot be compared with the full baseline.

## Current authoritative configuration

Defaults follow the executable results of `resolveWindowsE2EShardTotal()` and `listDefaultFormalE2ESpecs()`:

- Without shard arguments, every platform and resource tier uses 1 shard. A normal full run enables multiple isolated shards only with an explicit `--shards=N` or `ZCODE_E2E_SHARD_TOTAL=N`; each shard keeps `maxInstances=1`. An explicit `--shards` wins over `ZCODE_E2E_SHARD_TOTAL`.
- WDIO native `--shard`, targeted spec, manual-review and capture always stay single-shard and take priority over `--shards` and `ZCODE_E2E_SHARD_TOTAL`.
- The default formal scope is discovered dynamically by `listDefaultFormalE2ESpecs()`; no fixed count is a gate.
- `test:e2e:windows:sharded` fixes `--shards=10`. `pnpm test:e2e -- --shards=N` may diagnose other concurrency but does not replace the fixed-entry acceptance.
- `windows-e2e-shards.test.ts` must lock the inclusion of representative formal specs, exclude manual-review / live provider, and prove the union of explicit shards has no omission and no duplicate.
- Every explicit parallel configuration keeps: independent HOME / run id / artifact / network capture / Chromium profile per shard; `maxInstances=1` per shard; the union of shard specs equals the default formal scope exactly, without duplicates.

The 2/4/8/9/10 shard counts and 53/55 spec counts in the history section below are values of the corresponding experiment rounds and never override this section.

## Lifecycle facts

The default entry creates one WDIO child. Even with one child, when HOME is not specified it must derive an independent HOME from the parent runner's run id so two concurrent default runs do not clean each other's app data. An explicit single-child HOME keeps its path. With explicit parallelism the safe concurrency unit is the shard created by the parent runner (own HOME, run id, artifact, network capture, Chromium profile). Raising WDIO `maxInstances` within a shard is not allowed: several workers would reset the same HOME.

```text
pnpm test:e2e (default)
  -> e2e-report build
  -> single WDIO child (HOME=.e2e-home-<runId>)
  -> formal specs in sequence -> root summary

pnpm test:e2e:windows:sharded (performance acceptance, fixed --shards=10)
  -> e2e-report build
  -> desktop build (once, parent)
  -> agent build (once, parent)
  -> shard 1 ─┬─ spec worker 1 ─> Electron session ─> deleteSession ─> cleanup
              └─ spec worker N ─> Electron session ─> deleteSession ─> cleanup
  -> shard 2 ─┬─ spec worker 1 ─> Electron session ─> deleteSession ─> cleanup
              └─ spec worker N ─> Electron session ─> deleteSession ─> cleanup
  -> shard manifest
```

### Process identity and reclamation

On macOS the Electron main command line may be reduced to `ZCode E2E` without the run id and HOME arguments. Runtime sampling confirmed that Chromium child processes still carry the current run's `--user-data-dir`, which lives in the run cache, not HOME. Scanning only by HOME and run id misses main and hits only independent processes such as crashpad, so the exit barrier fails and blocks later workers.

Cleanup identity must include the Chromium profile root exclusive to the current run, covering all worker profiles of that run. Path matching must respect directory boundaries and Windows separators and must not hit adjacent runs or similar prefixes.

```text
current run profile -> Chromium child -> Electron main -> ChromeDriver
                                            |
                                            v
                                  collect the full child process tree
HOME / run id -> standalone or orphan processes --> exit barrier -> next worker
```

Only identity-confirmed child processes may complete the Electron/ChromeDriver parent chain; never clean by process name alone. A single-session reload must still keep ChromeDriver. Unit tests cover lost launch arguments, adjacent-run isolation and Windows paths; the session lifecycle E2E uses a real process snapshot to verify main is found without an explicit main PID, and verifies the exit barrier through consecutive worker runs.

## Root causes and priority

### P0: spec `after` quits Electron early

52 of the default formal specs call `clearAppData()` in `after`. The helper first runs `electron.app.quit()` and waits up to 10 seconds for the PID to exit before deleting app data; but the WDIO config already requires ChromeDriver to close the renderer first, with the `BrowserWindow.closed` listener then triggering `app.quit()`. The two ownerships conflict:

```text
current:
spec after -> clearAppData -> app.quit -> wait PID up to 10s
          -> ChromeDriver DELETE faces an invalid browsing context -> long tail
          -> afterSession cleans process and HOME again

target:
spec after -> does not preempt session close ownership
          -> WDIO after registers closed listener
          -> ChromeDriver DELETE closes renderer first
          -> closed listener -> app.quit -> host/agent dispose
          -> afterSession verifies process tree exit and deletes HOME
```

An older A/B toggled only WDIO `after` while the spec itself still quit early through `clearAppData()`, so both groups took the same slow path; it is not evidence against this root cause.

Requirements:

- `clearAppData()` must not call `app.quit()` during the closing phase of a WDIO-managed worker.
- The authoritative app data deletion point is `afterSession`, after process exit.
- Helpers that explicitly verify restart semantics (for example Coding Plan, provider restart) keep `quitElectronAppGracefully()`; they must not become restart-free.
- The failure path still scans and cleans Electron, host and agent by run id/HOME, not only the main PID.
- The fix reason is recorded as a Chinese comment in the helper (as the original spec states).

### P1: explicit shard concurrency and historical-duration balancing

Machine: 8 logical CPU / 32 GiB. Four-shard resource samples showed CPU P50 about 98.5%, P95 100%, with about 16 GiB memory free; the best speedups were 38.1% and 44.3%. Resource-tier defaults used earlier proved unstable under high concurrency (session/cleanup), so the default converged to 1 shard; callers pass `--shards=N` or `ZCODE_E2E_SHARD_TOTAL=N` per machine.

Going from 2 to 4 shards cannot strictly halve the time because of the parent build fixed cost, so it must be validated together with the P0 lifecycle fix. If startup contention cancels the gain, prefer short staggering, a shared read-only app stage or historical-duration weighting; never raise concurrency above the logical core count.

Scheduling: shards use versioned historical-weight LPT. The weight file records per-formal-spec worker milliseconds under concurrent contention and a 60-second fallback for new specs. The runner places the longest unassigned spec into the currently lightest shard, then restores stable path order within the shard. Weights only affect isolated shards created by the local parent runner; WDIO native `--shard`, targeted, capture and manual-review keep their semantics.

The parent runner's agent build uses the existing Turbo content cache by default (cold cache still builds the full dependency graph; warm cache measured about 1.7 s). An explicit `ZCODE_DESKTOP_AGENT_BUILD_MODE` still overrides it.

Each isolated shard receives the already built `out` (about 94 MiB, about 2,600 files) as a runId-isolated immutable snapshot in its own run cache. Snapshots are built by per-file hard links, falling back to per-file copy when link is refused (cross-volume `EXDEV`/platform), preserving target path, strict existence check and `onComplete` deletion semantics. `COPYFILE_FICLONE` was tried and had no effect on Windows (reverted). Starting directly from the shared `out`, or reducing specs or replay time boundaries to gain speed, is forbidden. Prepare dropped from about 30 s to about 4 s per shard.

Hard lower bounds from indivisible workers were removed by splitting formal specs along case-catalog boundaries (restart recovery vs Turbo capability; Turbo I35-I37 two-state recovery vs I38-I42 cross-capability switching) without pruning cases or changing assertions/restart/replay/product waits. After the 2026-08-31 provider flattening, restart recovery keeps only I25-I26, which still have product objects.

### P2: deterministic waits and internal `reloadSession`

Entered only when P0/P1 do not reach the goal:

- the fixed 33 s wait of `conversation-session-v4-load-older`;
- slow success-path replays in `v4-vertical-slice` and `v4-scroll`;
- unnecessary repeated `reloadSession()` in the Coding Plan multi-scenario and provider restart helpers;
- the remaining roughly 11.65 s fixed pauses become events, mock barriers or geometry-stable conditions.

Do not shorten `waitUntil` caps that the success path never pays, nor cases that explicitly verify product time boundaries such as `>45s`, `>15s`. HLP02's fixture was reduced from 25 to 21 turns (the 21 needed to cross the 60-row tail window; the removed 4 added no state combination); the E2E build scales keep-warm to 1 second while the production default of 30 seconds stays verified by fake-timer unit tests.

### Cleanup ownership and cost

Each worker already resets the shard HOME in the next `beforeSession.resetHome`; recursively deleting app data again in `afterSession` duplicated I/O and often waited on SQLite `-shm` locks. Ownership converged: `afterSession` only waits for the process tree to exit and deletes the worker's Chromium profile; `onComplete` deletes the whole shard HOME after all workers end (the final worker has no next `beforeSession`, so `onComplete` still covers it and leaves no user data).

On Windows the process tree PID set of one worker is merged into a single `taskkill /PID ... /T /F` instead of one `taskkill /T /F` per PID (the parent's `/T` already covers children; repeated per-PID calls amplified CIM/taskkill contention under 8-shard concurrency). The strict exit barrier is unchanged: after the command, the current run id/HOME is rescanned and any leftover still fails `afterSession`. For the common afterSession path the known Electron main PID is waited directly and reclaimed with `/T`; orphans are scanned only if the main PID already exited, and a final unconditional strict run id/HOME scan always remains. Isolation is not relaxed.

### Desktop build cache correctness

The desktop E2E build uses a content fingerprint cache. The fingerprint must describe the full semantics of the final bundle, not Git HEAD plus a hand-written directory list:

- Inputs: production sources and manifests collected recursively from `@zcode/desktop` along the `pnpm-workspace.yaml` workspace dependency graph (so tsup-inlined dependencies such as `@zcode/server` and later workspace dependencies enter the key automatically); desktop build scripts/config; root lockfile; Git HEAD; root `.env`, `.env.local`, `.env.production`, `.env.production.local`; and build-time environment (at least coverage, endpoint, OAuth, CDN, environment gate and build metadata variables, distinguishing "unset" from "explicitly empty").
- Reuse only when the stamp matches and the required artifacts still exist. `ZCODE_E2E_FORCE_DESKTOP_BUILD=1` forces invalidation; existence-only checks of old artifacts are not allowed.
- Regression tests must separately prove that switching `ZCODE_E2E_COVERAGE`, editing `packages/server/src` and editing the root `.env` change the fingerprint; "same commit" is no substitute.

```text
workspace dependency graph sources ─┐
production .env* files ─────────────┼─> content fingerprint ─> stamp + required artifacts match ─> cache hit
build-time environment variables ───┤                           any mismatch ───────────────────> cold build
Git HEAD / lock / config ───────────┘
```

The shared build cache folds "check, build, artifact validation, stamp commit" into one cross-process critical section. The lock uses atomic directory creation under the shared `.e2e-cache`; a waiter that obtains the lock recomputes the fingerprint and rechecks the cache, never reusing a miss from outside the lock. After a successful build, at least main, host, scheduler, both preloads and both renderer HTML entries must exist; the stamp is written to a temp file in the same directory and atomically renamed. Any build/validation failure commits no stamp, and `finally` releases the lock. A lock whose owner PID has exited may be reclaimed safely; a live owner can only be waited on or time out.

```text
runner A: acquire lock -> recheck miss -> clean/build -> validate -> atomic stamp -> unlock
runner B: wait lock ------------------------------------> acquire -> recheck hit -> unlock
                       shared packages/desktop/out allows exactly one writer
```

### Startup stagger and summary integrity

A 2.5 s per-shard startup stagger was tried and removed: the net gain was insufficient and the default stagger was reverted. The first attempt was also invalid because the generic `delay()` calls `unref()` on its timer, so with no other live handle in `onPrepare` shards 2-8 silently exited 0 and only shard 1 produced a summary (5 specs / 10 cases ran although the manifest listed 54 specs). The parent runner now enforces a gate: any child that exits 0 without a summary is judged failed, and an empty run must never count as success.

### Failure diagnostics and WebDriver request bounds

The 10 s failure-artifact outer cap was reverted: the default stays 60 s. A later environment check showed `ZCODE_E2E_FAILURE_ARTIFACTS=1` was not set on the machine, so `E2EFailureArtifactCollector.start/complete` was a no-op throughout; the earlier attribution of low test-result counts to a background recording overlapping the next worker was wrong.

The WebDriver bound (30 s per single request, zero protocol retry, with the explicit env override and a 5-minute hard cap kept) produced the best default-entry walls `933,828 ms` (-54.97%) and strict recheck `1,013,926 ms` (-51.11%), but with only 74-75 test results (a complete run has at least 82) and infrastructure failures aborting specs in hooks. The source states both that these defaults were revoked (restoring WebdriverIO native request config: `connectionRetryTimeout` 120,000 ms, `connectionRetryCount` 3) and, in its last paragraph, that the current state keeps the 30 s / zero-retry bound together with the 60 s failure-artifact default and the latest LPT profile. The later statement is kept here as current: 30 s single WebDriver request, zero protocol retry, 60 s failure-artifact default, latest LPT profile, hard-link staging, build cache, batched process cleanup, app-data ownership convergence and the HLP02 fixture optimization.

Reference: a bad renderer target on `execute/sync` could consume about 300 s in a `before` hook (15 s preflight `waitUntil` target x default 120 s request x 3 retries, not protected by the 120 s Mocha case timeout).

Performance acceptance outcome: the two historical acceptances happened before the retry spec was retired and produced 10 summaries and 55 requested specs, best `933,828 ms` (-54.97%) and strict recheck `1,013,926 ms` (-51.11%). The retry retirement came from a later product ruling and is not counted as performance pruning. The current suite is still not green and loses results in hooks; that stability risk is tracked separately and a passing test must not be mistaken for this performance acceptance. Higher concurrency did not help: explicit 10-shard `1,140,515 ms` (78 results) and 12-shard `1,102,432 ms` (80 results) still showed ContextId, process-exit barrier and EBUSY failures, so case loss comes from session/cleanup instability of the failing suite under high concurrency, not from request bounds.

## Mocha root hook readiness barrier (2026-07-20)

WDIO merges the project `config.before` and `wdio-electron-service.before` and runs them concurrently with `Promise.all`. The project preflight ran `getWindowHandles`, `switchToWindow` and `execute` while the service was still establishing the CDP ContextId, injecting `browser.electron` and binding Puppeteer / the active window, so five composer/edit/fork cases shared one ContextId/window-initialization failure (batch `ci-conversation-246048-679348`: `before` P50 `1,025 ms`, P95 inflated to `60,680 ms` by the failure recovery chain).

Target order: a real Mocha root `beforeAll` hook is the barrier after the Electron service completes.

```text
WDIO session ready
  -> config.before + wdio-electron-service.before (concurrent, but the project hook sends no browser command)
  -> runner waits for all before hooks
  -> Mocha rootHooks.beforeAll
       -> renderer bridge preflight
  -> spec before / beforeEach / test
```

- Project `before` only stores the current worker specs. All renderer/CDP/WebDriver preflight commands live in `mochaOpts.rootHooks.beforeAll` and are recorded as a separate `before-suite` lifecycle.
- Do not carry the failure barrier in WDIO config `beforeSuite`: WDIO's `executeHooksWithArgs` logs ordinary hook errors and resolves, so Mocha treats the root hook as successful and runs the test body. A real Mocha root hook rejection aborts the test body, counts a root-hook failure and still enters the runner's session cleanup.
- Preflight failure throws the existing `e2e-bridge-preflight infra failure`. Calling `browser.reloadSession()` inside the hook is forbidden: it creates a new session without waiting for the old Electron process tree to fully exit, spreading one startup failure into a second old/new-Electron coexistence race. Future auto-recovery may only retry from the launcher/worker outer layer after the `afterSession` exit barrier; no retry and no fixed sleep is added now.
- Acceptance: a config-level regression test locks hook order and that the preflight function contains no `reloadSession`; desktop E2E typecheck, full typecheck and lint pass.
- Verified (`desktop-e2e-20260720-064358-309`): four related specs, five cases pass, test phase 39 s, `before-suite` P50/P95 `1,333/1,454 ms`, all Electron/ChromeDriver/host/agent cleaned, no leftover process. A forced preflight rejection on the real Mocha runner gives failure count 1 with the test body not executed; the healthy path runs strictly `preflight -> test body`.

### Bridge readiness state machine (batch `ci-conversation-246384-680725`)

The hook order fixed only the first race layer: 6 of 42 workers spent about 30 s in `before-suite` and exited with `Timeout exceeded to get the ContextId`. The old `wdio-electron-service@9.2.1` catches that exception in `initCdpBridge()` and returns an unusable API stub, so the service `before` looks complete and the renderer preflight fails later with an `execute/sync` timeout. Also, I38/I39/I42 call `browser.reloadSession()` directly; WebdriverIO rebuilds only the protocol session and does not rerun the Electron service `before`, so the new Electron keeps using the old main-process CDP bridge.

Startup and real restart use one explicit readiness state machine:

```text
initial worker
  -> project reload-aware wrapper -> wdio-electron-service 9.2.1 before
       -> ContextId initialization
       -> strict main-process execute probe
       -> failed: reset service bridge -> reconnect once -> probe
  -> Mocha renderer preflight
  -> case

in-spec real restart
  -> arm old Electron app.quit on BrowserWindow.closed
  -> capture old main-PID rooted tree + runId/HOME identity matches
       -> main / renderer / GPU / utility / host / agent PIDs
  -> deleteSession(shutdownDriver=false) closes old window but keeps ChromeDriver
       -> project overwriteCommand waits the captured process tree exit
            -> timeout: POSIX TERM -> KILL / Windows taskkill /T /F
            -> rescan the same runId/HOME; any remaining PID fails without reload
  -> only after zero remaining PID: browser.reloadSession creates new WebDriver session
  -> service.onReload rebuilds CDP bridge + active window binding
  -> restore renderer preferences -> assertions
```

- A healthy start adds one main-process probe and no fixed sleep; only a failed first bridge initialization triggers one bounded reconnect.
- A real restart uses the PID returned by the Electron main bridge as the authoritative tree root before delete, joined with the current runId/HOME identity, to record the old Electron's full process tree. The macOS main command line does not guarantee the appArgs marker, so marker-only scans are not enough.
- Then `deleteSession({ shutdownDriver: false })` keeps ChromeDriver, and the exit barrier completes before `reloadSession` creates the new session. Waiting only for the main PID does not prove renderer/GPU/utility or derived host/agent released the profile, pipes, ports and ContextId.
- After a natural-exit timeout, reuse the E2E runner's cross-platform TERM/KILL or `taskkill /T /F` strategy and rescan by the same identity; zero is required to continue and surviving PIDs go into the error message.
- Never call the default `deleteSession` early from outside (it closes ChromeDriver and then accesses a dead port); the only allowed pre-delete passes `shutdownDriver: false`. Never place the wait after the new session started.
- `onReload` must rerun service initialization; the presence of `browser.electron` is not proof that the bridge is usable.
- The official scoped v10 migration is not a premise since the current environment cannot fetch the new dependency; the local wrapper keeps the existing launcher/capability contract and promotes initialization failures swallowed by the old service into one bounded reconnect or an explicit failure.
- The change affects only the Desktop E2E runner; product process responsibilities, desktop continuous, mobile replayable and workspace identity semantics are unchanged.

## Verification order

1. Establish the default full baseline and freeze run id, wall-clock, spec/case counts and failure classification.
2. Targeted A/B of an ordinary conversation spec and smoke, comparing worker, `deleteSession` and afterSession, and confirming zero current run/HOME processes afterwards.
3. After P0, re-measure the same scope to isolate the lifecycle fix.
4. Add runner pure unit tests, then run the full suite.
5. If the full wall-clock is still above 50% of the first baseline, return to attribution and design in P2 order.
6. Finally run `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, `pnpm lint`, and check that no E2E Electron/host/agent/Chromedriver process remains.

## Acceptance gates

- The fixed entry `pnpm test:e2e:windows:sharded` actually uses 10 shards.
- Its parent runner full wall-clock `<= first baseline * 0.50`.
- The formal spec/case scope is not reduced; all shard summaries are traceable; a run needs all shard summaries and a complete test-result count, never an empty run.
- `clearAppData()` no longer lets ordinary specs destroy the WebDriver browsing context early.
- Worker and deleteSession P50 drop significantly for ordinary no-reload specs.
- Explicit restart/reload cases keep passing.
- After a run, Electron, host, agent and Chromedriver counted by run id/HOME are zero.
- desktop E2E typecheck, full typecheck and lint pass.
- Pre-existing product assertion failures are reported separately from newly introduced failures.

## First-baseline reference

Run `desktop-e2e-20260716131832268-p8992-a18640ce7414c30d`: Windows default 2 shards with `maxInstances=1` per shard; about 53 specs, 86 active cases, 3 skipped. Parent wall-clock `2,073,785 ms` (34 min 33.8 s); the halving line is `<= 1,036,892 ms` (17 min 16.9 s). Shard 1: 27 workers `1,849,626 ms`; shard 2: 26 workers `1,271,709 ms`; aggregated workers `3,064,557 ms` of which about `1,170,262 ms` is per-worker fixed cost outside the test body. `infraFailureCount` 0 on both shards; existing failures are kept separate and early end after failure is not counted as a performance gain. Native contiguous slicing left a tail gap of `577,917 ms`, showing that averaging by spec count is not averaging by duration; parent build/scheduling fixed cost is about `224,159 ms`.

A historical four-shard run (92 workers) showed: workers 11,446.6 s total (124.42 s/worker); non-test-body 4,575 s (49.73 s/worker); WebDriver `deleteSession` 114 calls 1,508.0 s (13.23 s/call; the 22 extra over workers come mainly from in-spec `reloadSession()`); afterSession 342.8 s; beforeSession 28.3 s. Host cleanup in the logs averaged about 1.50 s, so the roughly 10-12 s long tail sits in the ChromeDriver DELETE roundtrip, not host dispose.

## Experiment history (outcome only)

Rounds 1-18 (2026-07-16) tried 4/6/8/9/10/12 shards, LPT weight refreshes, Turbo agent cache, hard-link staging, startup stagger and failure-diagnostic bounds. Best default-entry results were 4 shards -38.1%/-44.3%, 8 shards -48.9%, explicit 9-shard `1,043,980 ms`, explicit 10-shard `1,041,967 ms` (both within 5-7 s of the halving line), then `933,828 ms` / `1,013,926 ms` with incomplete result counts (rejected, see above). The formal scope was 53 specs, later 55 (including `conversation-session-v4-retry.test.ts`, retired by a product ruling) and is now 54 by the authoritative section above. Full history: `git show 6c0f4203:docs/testing/desktop-e2e-runtime-performance.md`.
