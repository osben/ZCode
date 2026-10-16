# Local TTFT Launch & ARMS Acceptance Checklist

> Status: in-progress

[Parent Contract](ttft-stage-telemetry.md) · [Query & Diagnostics Contract](local-ttft-queries.md) · [Dashboard Template](dashboards/local-ttft.json) · [How to Read a Trace](local-ttft-trace-reading.md) · [Platform Acceptance Evidence](local-ttft-platform-evidence.json) · [Ticket 01](../issues/ttft-stage-telemetry/01-local-send-stage-observability.md) · [Ticket 02](../issues/ttft-stage-telemetry/02-queued-retry-and-failure-diagnostics.md)

This document only covers deployment actions after telemetry is implemented: routing data to Beijing ARMS, completing platform acceptance, gradual rollout, capacity verification and cost tracking. The telemetry contract itself see the parent contract, query scope see the query contract.

**2026-09-15: Phase 0 Completed**, New service `zcode-local-ttft` Trace & Metric queryable in Beijing ARMS, percentiles, watermark correlation, labels and diagnostic scope all verified,实测 data见 `local-ttft-platform-evidence.json`. Local OTLP evidence见 `local-ttft-evidence.json`、`local-ttft-diagnostics-evidence.json`. Phases 1~3 still unfinished.

## Current State

| Gate                | Current State                                                                                                                                                                                                                                                 | Opened by                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Write Address       | Write address verified可写 (same base collects traces & metrics). Desktop main metrics reader does not create without endpoint (`packages/desktop/src/main/localTtftExporter.ts:46`), packaged version depends on build-time injection, this path unvalidated | Phase 1                                                                                      |
| Gray Switch         | `rendererActionTrace.localTtftEnabled` defaults false (`packages/shared/src/rendererActionTrace.ts:21`)                                                                                                                                                       | Phase 2: server-side `/api/v1/client/configs` delivery; single machine可用 env var forced on |
| Platform Acceptance | Completed: query, watermark, labels, and warehouse delay all verified; console界面 visual and retention/cost not done                                                                                                                                         | Phase 3                                                                                      |

Gray switch is independent of old Renderer/Agent Trace's `enabled`/`sampleRatio`; only opens TTFT without changing old Trace sampling & parent-child belonging.

## Phase 0: Direct Connection to Real ARMS on Local Machine, Platform Acceptance Completed (2026-09-15)

Platform acceptance does not depend on CI or gray release delivery; local dev direct connection can solve Ticket 01/02 platform items.

- [x] Take the接入 values currently in use by `zcode-cli-agent` (CI vars `ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT` / `ZCODE_PACKAGED_AGENT_OTEL_HEADERS`). Write key does not go to dashboard, does not go to this repo doc.
- [x] **Confirm this endpoint is OTLP base.** Measured base is `/apm/trace/opentelemetry`; `base + /v1/traces` & `base + /v1/metrics` both return 200, independent `/apm/metric/opentelemetry/v1/metrics` is actually 404. Previously worried "base contains trace segment causing metrics to hit non-existent URL" does not hold, `packages/desktop/src/main/localTtftExporter.ts:31` concatenation works.
- [x] Confirm backend same endpoint accepts metrics signal. **Conclusion: accepted**, therefore no need to add independent metrics endpoint injection to desktop main (the whitelist `packages/desktop/src/main/desktopRuntimeEnv.ts:216` stays as-is).
- [x] Use real controlled samples. Actually used two real E2E (`conversation-session-ttft-stages` ran 2 times, each 3/3 passed; `conversation-session-ttft-diagnostics` 6/6 passed), total 12 sends; outlet configured per online shape only sets base endpoint, does not separately set `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. Forwarded 85 times all 200, no failure.
- [x] Trace acceptance: `service.name = zcode-local-ttft` queryable (was 0); `observation_id` hyphen-removed equals traceID; single send 62 spans, root 701.70ms and six main stages union 701.69ms consistent, `unattributed_ms=0` verified; `local_ttft.checkpoint`, `.start`, `.first_text` same Trace root; `.started` point records duration 0.
- [x] Verify actual metric series names: **no unit suffix appended**, query contract's `zcode_local_ttft_*` default name成立.
- [x] Run total P50/P95, stage P95, preparation sub-stage P95 & matching `_count`, DELTA + `sum_over_time` scope成立. Phase sample count 18 = 3 sends × 6 phases, not amplified by attempt.
- [x] Diagnostic scope (Ticket 02): `records` complete by kind (start 16 / first_output 12 / first_text 12 / excluded 4 / checkpoint 442); `excluded` distinguishes cancelled / failed / guided; `attempt` distinguishes failure retry & first output by role+outcome; `no_output.wait` records cancelled & failed; `preparation` covers context / hooks / persistence / mcp / tools / request_assembly / user_confirmation / retry_wait.
- [x] Labels are controlled low-cardinality (app_version、os、provider、model、quality、send_mode、visibility、stage、role、outcome、kind), no correlation ID leaked to metric labels.
- [x] Warehouse visible delay: second run ends instantly starts polling, Trace & Metric first poll hits (upper bound <5s). This is "visible at end" upper bound, not per-condition precise delay.
- [x] Write results back to Ticket 01 & Ticket 02 platform acceptance items, local test and platform acceptance recorded separately.
- [ ] **Still not done**: Visually confirm watermark rendering & navigation in ARMS/Trace Explorer console. This time all passed only by reading API data integrity, console confirmation requires login.
- [x] Write back results to Ticket 01 & Ticket 02 platform acceptance items, local test and platform acceptance separate.

Side effect: 12 controlled sample sends to production telemetry库 this time,可按 `provider="e2e-deepseek"`、`model="deepseek-v4-flash"` identify exclusion, these two tags won't appear in real user samples.

## Phase 1: Get Packaged Version with Write Configuration

CI variable permission needed (release/CI owner).

- [ ] Confirm CI variable可用 in target build. `resolveBuildPackagedAgentTelemetryEnv` (`packages/desktop/tsup.config.ts:84`) requires endpoint & headers paired, production must HTTPS, release branch/tag missing will directly cause build failure. When variable in place, desktop main automatically obtains metrics outlet, **no new build config needed**.
- [ ] Output a dev/preview package, launch from Finder / Start Menu once. Install package starts without shell env vars, historically Agent therefore silently fell into Noop, comment见 `packages/desktop/src/main/desktopRuntimeEnv.ts:213`. This is the only path not covered by Phase 0: Phase 0 runs runtime env injection.
- [x] ~~If Phase 0 discovers metrics needs independent endpoint, finish channel modification before packaging.~~ Phase 0 confirmed same base collects metrics, no modification needed.

## Phase 2: Gradual Rollout

- [ ] Server `GET /api/v1/client/configs` returns `data.configs.rendererActionTrace.localTtftEnabled = true` (parse见 `packages/desktop/src/main/rendererActionTraceRollout.ts:53`). Request carries `app_version` & `platform`,可分版/平台圈人.
- [ ] Start from small group. Gray is bounded full collection within, no active sampling, first observe volume per Phase 3 then expand.
- [ ] Internal verification using `ZCODE_LOCAL_TTFT_ENABLED=1` single-machine forced on (`packages/desktop/src/main/rendererActionTraceIpc.ts:123`), do not modify online config.
- [ ] Confirm after gray launch old business completion、RUM TTFT & send funnel count scope unchanged.

## Phase 3: Capacity, Cost & Retention

Threshold before expanding gray, all need verification on ARMS, doc estimates cannot replace.

- [ ] Series count: 10 Histogram + 2 Counter, 15 explicit buckets + `+Inf` + sum/count, theoretical limit ~46,592 sequences/same resource group. Also need check backend resource label mapping & whether overflow sequences produced.
- [ ] cardinality not topped: per instrument upper limit 26, provider/model max 16 groups (`packages/desktop/src/main/localTtftExporter.ts:71`). Topped means lost discriminability, enters `other`.
- [ ] `zcode.local_ttft.dropped` online is 0; non-0 indicates queue or capacity boundary adjustment needed, distinguish reason by queue full、removal capacity、transfer timeout & truncation.
- [ ] Retention reaches target: details 7 days, aggregation ≥30 days, and actual cost estimation. This item marked as deployment condition to verify in parent contract.

## Phase 4: Dashboard Deployment

- [ ] Import `dashboards/local-ttft.json`, replace `total_metric` / `stage_metric` variables with actual metric names verified in Phase 0.
- [ ] Default experience view with `quality="complete"` & `visibility="foreground"`; `missing`、`clock_invalid` & observation series only enter diagnostic view. Observation series labels are state at this phase observation, not represent message finally stays foreground, mixing pollutes default distribution.
- [ ] Each percentile chart配同 filter &同时间窗的 `_count`. Do not add P95, also do not derive stage P95 by total P95 minus model P95.

## Local Reproduction Entry

Not connecting to real ARMS, local outlet verification walk [Query Contract's Local Reproduction](local-ttft-queries.md#本地复现): first start `packages/desktop/scripts/ttft-otlp-receiver.mjs` (only listens localhost:14318), then run `conversation-session-ttft-stages` / `conversation-session-ttft-diagnostics` two candidate cases. This path only proves final OTLP contract, does not constitute platform acceptance.

## Not in This Checklist

- Desktop remote workspace, mobile & web remote control TTFT collection (parent contract Out of Scope).
- Ticket 01 recorded CLI full-unit test failures (442 files passed / 76 failed, failures not itemized by origin, stale scenarios in开工 HEAD also fail). Does not block platform acceptance, but advocates overall completion needs separate disclosure.
- Windows / Linux real machine & mobile remote control E2E running evidence.
