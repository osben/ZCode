# Cold start fails after changing desktop settings and the data directory

Status: done

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, patch 09, batch `r3-server-20261011150809016-2aeaba`;
`desktopauthority` failed after 203.1 s.

## Symptom

With a remote project active, the real Settings page changes hardware acceleration, browser certificate
policy and the local data directory, saves, then fully restarts. Before restart, desktop fields wrote local
only, the Source auto-archive cross-check was fine, Source desktop fields were not polluted and the local
canary was copied to the new data directory (`settings-authority.json`). The new Main showed “无法完成启动准备 /
数据准备进程意外退出或连接中断” (cannot finish startup preparation / the data preparation process exited
unexpectedly or its connection broke) instead of the main UI. Database startup attempt
`6bae681b-502c-4a44-9231-634811d33575` ended after 2692 ms with `status=failed, errorCode=transport_closed`;
the Host logged a Worker exit then `Storage preparation failed: transport_closed`. Free disk was above 128 GB.
The test waited only for an operable main UI, so a wrong default project is not the cause.

## Root cause (confirmed)

Stack `host/index.js:2:458` against the same-version test bundle falls in the Worker exit branch of
`prepareSessionStorage`, so the exiting worker is the **CLI session-DB preparation Worker**, not the
`prepareHostStorage` task-index Worker; the outer `transport_closed` is not a database root cause. The branch
succeeds only after `storagePrepared`, a clean exit and no earlier error. The Host drained the Worker stderr
without keeping it, so history lacked the raw CLI error and exit code.

Batch `r3-server-20261012012923737-60d156` re-ran `desktopauthority` (205.4 s, still failing) with the
test-only `storage-worker-diagnostics.mjs` (E2E preload observer; does not replace the storage entry, control
frames, exit code or recovery flow; stderr capped at 64 KiB in a 0600 artifact file):

| Moment                       | Exit code | stderr                                                                   | Last control frame      |
| ---------------------------- | --------- | ------------------------------------------------------------------------ | ----------------------- |
| before changing data dir     | 0         | empty                                                                    | startup/storagePrepared |
| after save and cold restart  | 1         | `--cwd path is not accessible: <new-data-root>/.zcode/workspace/default` | none                    |

On the failure page the new data root and `.zcode` exist but `.zcode/workspace` and its `default` child do
not: the startup working directory is missing (not DB corruption or hardware acceleration).

```text
remote project is lastActiveWorkspace + new data root
  → copyDataDirectory copies only .zcode/v2
  → resolveStartupWindowBootstrap's remote-active branch returns {}, creates no local default cwd
  → Main still passes the new root's default as agentSpawnFallbackCwd
  → Host has no local warmup targets, so uses that cwd to prepare the session DB
  → CLI --cwd validation fails, exit 1, storagePath never sent
  → Host drops stderr and shows transport_closed
```

Responsibility boundary: `packages/desktop/src/main/startupWorkspace.ts:resolveStartupWindowBootstrap` and the
`agentSpawnFallbackCwd` hand-off in `index.ts` do not guarantee that the app-owned cwd given to storage
preparation exists. `resolveZCodeAgentSpawnCwd` keeps the original path when neither the request nor the
fallback is usable, so the CLI rejection follows the path-admission contract.

Counterfactual probes: the real bootstrap + cwd resolver with a remote active selection and a new default
directory returned bootstrap={}, cwdCreated=false, cwdExists=false. The same-version CLI bundle under the
Electron Node runtime with identical argv/env/isolated DB exits 1 with the same stderr and no frames when the
cwd is missing, and exits 0 with `storagePrepared` once only the directory is created. Isolated probes with
retained old-directory DB copies (task-index Worker) and an explicit temp DB path (CLI Worker, Node and
Electron Node) all exited 0 with empty stderr. Hardware acceleration, certificate policy and data copy are not
the root cause.

## Fix

Fix target `56ca74621f0da771728e310e36d967afd5259c6d`. In the remote-active branch with no local warmup
target, Main's `resolveStartupWindowBootstrap` asynchronously creates the data-root-resolved
`conversationWorkspaceDir` and waits for it before handing off to the Host. The returned navigation/warmup
result stays empty: it creates no user remote path, adds no local project and does not take remote focus. It
reuses the existing first-start / invalid-local-directory mkdir contract; errors propagate, with no swallow
or retry. Rollback means reverting the directory preparation in that branch; already created directories
remain and the original startup failure reappears. No change to CLI path validation, storage protocol, copy
scope or recovery retries.

Tests: new/old remote active settings and directory-creation-failure regressions failed before and pass after;
`startupWorkspace`, `hostDatabaseStartup`, `storagePreparationWorker` 20 tests pass; 17 affected files / 219
tests pass; root typecheck, lint (207 pre-existing warnings, 0 errors), architecture (0 violations), fixtures
and format pass. The E2E keeps the Source-settings-not-polluted and post-restart config read assertions and
adds before/after existence evidence for the new root's default cwd.

## Final verification

Batch `r3-server-20261012013853643-f32109` (rebuilt business package; source manifest SHA-256
`8a674355697c004b22a12bbe6e973df9adf75501652f43fbd2d8f01f8810a94a`):

| Scenario         | Result         | Confirmed behavior                                                                                                              |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| desktopauthority | PASS, 107.7 s  | full original settings combination and restart; new-root default cwd absent before, present after; settings kept, Source clean, canary copied |
| coldreconnect    | PASS, 150.0 s  | active remote task cold-restores, other project opened on demand, both continue, auto-reconnect off and manual restore         |

The Worker observer recorded exit=0, empty stderr and last frame startup/storagePrepared both before and after
restart, a same-scenario contrast with the pre-fix exit=1 / unreachable cwd / no frames. The E2E ran on a
Linux server; local focused tests cover macOS filesystem behavior and are not extrapolated to native Windows.

Evidence: `packages/desktop/.e2e-artifacts/issue15-20261012/` (`worker-cwd-observation.json`,
`worker-cwd-counterfactual.jsonl`, `bootstrap-probe.json`, `storage-workers/*.json`) and
`packages/desktop/.e2e-artifacts/issue25-fix-20261012/` (`summary.json`, `settings-authority.json`,
`storage-workers/`).
