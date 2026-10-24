# Windows E2E Runtime Optimization

> Historical optimization plan (2026-07-10), implemented; this file keeps the current
> Windows E2E runtime contract, measured outcomes and open follow-ups.
> Full history: git show 4d4e9adb:docs/superpowers/plans/2026-07-10-windows-e2e-runtime-optimization.md

**Goal:** Keep Windows `pnpm test:e2e` within a bounded wall-clock budget while preserving
cross-spec state isolation and intentional time-boundary coverage.

## Current runtime contract

- Default Windows `pnpm test:e2e` is build-once + sharded: `packages/desktop/scripts/run-windows-e2e-shards.mjs`
  builds desktop/agent once, then starts N WDIO children with `--shard=x/N`.
  `test:e2e:windows:sharded` runs `pnpm test:e2e -- --shards=10`.
- Each shard gets an independent `ZCODE_E2E_HOME_DIR` (includes run id + shard index),
  `ZCODE_E2E_RUN_ID`, artifact directory and network capture directory. The parent runner
  returns non-zero if any child fails and never overwrites child summaries.
- Targeted runs (`--spec`), manual review and capture modes pin a single child; sharding is
  always explicit, never implicit from machine resources.
- Historical spec weights decide shard assignment only; each shard restores stable path
  order within the bucket (`partitionE2ESpecsByWeight`).
- Process cleanup (`packages/desktop/test/e2e/helpers/e2e-process-cleanup.ts`) matches only
  processes whose command line contains the current run/shard HOME marker, then reclaims the
  PPID subtree. Shared markers such as product name, app entry point or `out/main` must not
  be used as roots. `onPrepare`, `afterSession` and `onComplete` reuse the same rule.
- Do not raise `ZCODE_E2E_MAX_INSTANCES`: workers share one HOME per run and `beforeSession`
  deletes it recursively. Cross-platform cleanup paths (macOS/Linux) stay intact.
- Time-boundary cases (ReadSessionContext >45s, title sidecar >15s, 90s model-switch replay)
  stay with their real durations; never shorten fixtures to fit a budget. Cases that
  intentionally cover a boundary go to an explicit slow lane instead of being silently trimmed.

## Verified outcomes

- A/B on teardown: skipping `app.quit()` before WDIO `deleteSession` only moves the wait
  (~26 s per spec either way); the original close semantics are kept so `before-quit` can
  still reclaim host/agent. The ChromeDriver slow-close path is an upstream cost.
- Full two-shard run (2026-07-11, 83 spec workers): 48:46 wall clock vs ~90:33 serial
  estimate for the same scope (~46% reduction), no residual Electron/Chromedriver/host/agent
  processes. Unattributed session/WebDriver cost (~43.9 min) rivals test-body cost
  (~43.0 min) and is the next cost center, not more shards.
- `tool-cross-product` is a single ~9 min worker with 51 real cases; do not compress it by
  changing assertions or fixture semantics.

## CI sharding (GitLab Windows conversation job; CI repo is not part of this tree)

- Promoted to `parallel: 4` with WDIO-native `--shard=$env:CI_NODE_INDEX/$env:CI_NODE_TOTAL`;
  `CI_NODE_INDEX/CI_NODE_TOTAL` stay in the run id so summaries, captures and failure
  evidence never overwrite each other. Rollback point is only the job's `parallel` count.
- The post-run summary coverage gate must use the same ordered allocation as WDIO 9.27:
  expand the full formal glob, sort within each glob, then
  `specsPerShard = max(round(totalSpecs / shardTotal), 1)` with consecutive slices. A shard
  summary must contain exactly its shard's specs, at least one test, and no foreign specs.
- Four passing parallel jobs' union equals the full formal set; no summary-merging fifth job.

## Open follow-ups

1. Finer-grained WebDriver session events (Chromedriver, CDP bridge, Electron exit,
   host/agent exit) to attribute the unattributed session cost.
2. Session-reuse canary for state-compatible specs only: each group must run the original
   cases/assertions with a forced HOME reset between groups, and grow only after case-count
   and pass-rate validation.
3. CI `container-boot` health gate before the main suite so an infrastructure failure stops
   dispatching instead of burning every spec's timeout.
