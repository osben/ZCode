# Desktop Formal Manual E2E CI

## Background

A CI entry runs the desktop E2E that already passed V4 formal admission, to locate desktop regressions on MR/web pipelines. It collects formal cases from the conversation-session direct-root glob and explicitly lists manually verified cross-domain formal specs; `manual-review/pending` is not picked up by the non-recursive glob.

Current state: manually optional. `test:e2e:conversation-session:auto` and `test:e2e:conversation-session:auto:windows` show as manual jobs in the `approve-mr` stage; not clicking never blocks later `build-app` / `build` steps, and a failure after clicking is handled as `allow_failure=true`. The job names keep the historical conversation-session naming, but the coverage already includes the admitted desktop formal subset.

## Manual formal set

`ZCODE_E2E_SPEC` currently uses formal-directory globs:

```bash
./test/e2e/conversation-session/*.test.ts,
./test/e2e/plugins/*.test.ts,
./test/e2e/workspace-file-tree-refresh.test.ts
```

- The conversation-session glob mechanically collects direct-root formal specs; a fixed count is not a gate. Every spec must first pass the formal admission audit: no old aggregate helper, a case manifest, a case-local provider fixture, and a request ledger consistent with the manifest.
- The plugins glob collects promoted plugin-domain cases.
- `workspace-file-tree-refresh.test.ts` is the promoted cross-domain formal case of the file-tree domain: it triggers no provider request and uses real workspace file fixtures to verify the refresh button and the live watcher refresh chain.
- CI keeps no second `ZCODE_E2E_EXCLUDE_SPEC` quarantine. Whether a spec is collectable is decided by directory location plus the admission audit; a case that does not yet meet the contract stays in `manual-review/pending` and must not be placed in direct-root and excluded by CI.

## Trigger rules

- A GitLab merge request pipeline shows two manual e2e jobs (macOS / Windows) after creation; click when needed.
- Pipelines created manually in the GitLab Web UI also show the manual e2e job and do not consume a runner automatically.
- Later `test` / `build-app` / `build` stages do not depend on the desktop formal e2e; not clicked, skipped or failed never blocks them.
- `build:desktop:app` waits only for the manual `approve:merge-request` confirmation; the macOS / Windows / Linux packaging jobs depend only on the `build:desktop:app` artifact.
- Target-branch scope follows the workflow rule: pipelines are created only for MRs targeting `main` or `staging`.

## Run command

The CI job runs the desktop WDIO Electron E2E on the host with a macOS shell runner:

```bash
E2E_PROVIDER_HTTP_MODE=replay \
ZCODE_E2E_SPEC='./test/e2e/conversation-session/*.test.ts,./test/e2e/workspace-file-tree-refresh.test.ts' \
pnpm --filter @zcode/e2e-report build:node

E2E_PROVIDER_HTTP_MODE=replay \
ZCODE_E2E_SPEC='./test/e2e/conversation-session/*.test.ts,./test/e2e/workspace-file-tree-refresh.test.ts' \
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

`ZCODE_E2E_SPEC` is handed to `wdio.conf.ts` only as an environment variable. CI does not append the same glob to the WDIO CLI `--spec`, so there is one spec-filter entry and the job cannot stop at `onPrepare` / build without stable worker scheduling.

Plain replay starts a local provider-fixture replay server, never reaches a real model upstream and needs no API key in CI. This entry does not start Docker.

## Windows parallel toolchain isolation

The Windows job uses GitLab `parallel` to create four independent jobs. They no longer use WDIO native contiguous slicing: before WDIO starts, the same formal glob is expanded, `packages/desktop/test/e2e/conversation-ci-spec-duration-weights.json` is read, specs are assigned deterministically by LPT to four buckets by historical worker duration, and `CI_NODE_INDEX` selects the current bucket and writes it back as an explicit `ZCODE_E2E_SPEC`. This balances long specs, multi-case specs and new-spec fallback, so file-name order does not leave the first shard with the heavy background/goal sets. Each job's summary validates only its own explicit subset; the allocator test proves the union of the four buckets equals the full formal set with no duplicates and a bounded estimated duration.

The current profile comes from the worker lifecycle durations of one successful full run of 78 specs / 200 cases; new specs use a 20-second fallback. Absolute durations may scale across platforms; LPT consumes only relative spec weights. When a new full Windows success artifact is available, refresh the profile with the same `worker` duration basis.

Distribution recomputed from the same runtime sample for the old native contiguous slicing and the new LPT. Durations are profile estimates, not new Windows CI wall-clock runs; they show the allocator no longer pins heavy specs on the first bucket.

| Allocation        | Cases per shard     | Estimated duration per shard | Max/min ratio |
| ----------------- | ------------------- | ---------------------------- | ------------: |
| WDIO native slice | `88 / 45 / 39 / 28` | `633s / 316s / 270s / 293s`  |          2.35 |
| historical LPT    | `52 / 55 / 41 / 52` | `375s / 381s / 375s / 380s`  |          1.02 |

```text
formal glob -> expand -> historical duration profile -> LPT bucket 1..4
                                                     -> CI_NODE_INDEX
                                                     -> explicit ZCODE_E2E_SPEC
                                                     -> WDIO -> subset summary gate
```

The four jobs may still land on one shell-runner host. The NVM install directory is machine-level shared state, so job setup must not repeatedly create or overwrite Corepack's `pnpm.ps1` there. Each job must create its own Corepack shim directory under the project temp directory keyed by `CI_JOB_ID`, put it first on the current process `PATH`, and mechanically verify before running pnpm that the actual command comes from that directory.

```text
Windows runner
  ├─ job A -> .tmp/corepack-<job-A>/bin/pnpm.ps1 -> weighted bucket 1
  └─ job B -> .tmp/corepack-<job-B>/bin/pnpm.ps1 -> weighted bucket 2

Forbidden: job A/B -> NVM_HOME/<node-version>/pnpm.ps1 (shared overwrite)
```

If the current process Node version already satisfies `NODE_VERSION`, setup does not call `nvm use`, which switches a machine-level symlink; only on a version mismatch does the existing use/install/use recovery chain run. The Corepack shim isolation changes only the CI tool launch path, not the pnpm store, workspace, E2E HOME, artifacts or native shard scope.

## SSH remote assets prepared automatically

The conversation formal glob includes `conversation-session-ssh-remote*.test.ts`. When the runner has `ZCODE_E2E_SSH_HOST` + `ZCODE_E2E_SSH_USERNAME` + `ZCODE_E2E_SSH_PASSWORD` (or any of `ZCODE_E2E_SSH_HOST` / `ZCODE_E2E_SSH_A_HOST` / `ZCODE_E2E_SSH_B_HOST`), `stageDesktopE2EAppOutput` in WDIO `onPrepare` stages `packages/desktop/mock-cdn/releases/<repo version>` into a runId-isolated directory for the SSH remote runtime.

That release directory is produced by `pnpm --filter @zcode/desktop prepare:remote-assets`. Known trap: only the CI `build:remote:assets` job ran that command, in the work slot of a `macos`-tag runner, while the conversation e2e runs on a dedicated e2e runner. `mock-cdn` is excluded from workspace persistence via `GIT_CLEAN_FLAGS`, but the two working directories are unconnected and the directory is named by version, so after every version bump the dedicated runner lacks the new directory and `onPrepare` aborts fatally (`SSH remote assets missing: .../mock-cdn/releases/3.12.0`, MR 2606, 2026-09-11).

Current behavior: when the SSH environment is ready but the release directory is missing, `onPrepare` runs `pnpm --filter @zcode/desktop prepare:remote-assets` automatically and then stages; an existing directory is skipped (idempotent, same-version persisted artifacts are reused). If the directory is still missing after prepare, the run keeps failing closed. Neither the conversation e2e job nor local SSH e2e depends on implicitly shared artifacts from other jobs / runner slots.

```text
wdio onPrepare (stageDesktopE2EAppOutput)
  └─ SSH env ready?
       ├─ no  -> skip remote release stage
       └─ yes -> mock-cdn/releases/<version> exists?
              ├─ yes -> stage into runId-isolated directory
              └─ no  -> run prepare:remote-assets automatically
                       ├─ produced -> stage
                       └─ still missing -> fail-closed fatal
```

## Artifacts

Every manual run writes to `packages/desktop/.e2e-artifacts/<run-id>/` and keeps it as a GitLab job artifact. Core files:

- `summary.md`
- `summary.json`
- `test-results.ndjson`
- `ci-pnpm-install.log`
- `ci-electron-install.log`
- `ci-desktop-e2e.log`
- `perf/container-samples.ndjson`
- `network-capture/`

## CI stdout

The job defaults `ZCODE_E2E_CI_STDOUT_MODE=summary`. In this mode the full stdout/stderr of dependency install, Electron binary repair and WDIO E2E go to artifact files, and the GitLab console prints only:

- The log file path of the current step
- After E2E ends: run id, exit code, duration, pass/fail counts
- Titles and error summaries of failed cases
- The tail of the log when `summary.json` could not be generated

This keeps high-frequency WDIO / Electron / app-server logs from flooding GitLab job stdout while keeping full troubleshooting material. To see live output temporarily, override `ZCODE_E2E_CI_STDOUT_MODE` to `verbose` in a Web pipeline.

## Boundaries

- The manual entry dynamically covers the desktop `desktop-continuous` conversation direct-root admitted formal specs, plugin-domain formal specs, and promoted desktop UI cases that need no provider, such as file-tree refresh.
- `manual-review/pending` does not enter this entry; a formal admission audit failure stops a wrong promotion at the mechanical gate.
- The historical Docker presets `conversation-session-admission`, `conversation-session-needs-docker-fix` and `conversation-session-tool-cross-product` have left the current configuration and cannot be used as V4 formal-admission facts.
- Docker `replay-isolated` stays for formal Docker admission and container-environment diagnosis; this entry runs plain replay only.
- The mobile `/remote` `web-remote-replayable` recovery semantics stay with the dedicated remote-control regression and are not proven by this job.
