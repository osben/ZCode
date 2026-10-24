# Local TTFT Launch & ARMS Acceptance Checklist

> Status: in-progress

[Parent Contract](ttft-stage-telemetry.md) · [Query & Diagnostics Contract](local-ttft-queries.md) · [Dashboard Template](dashboards/local-ttft.json) · [How to Read a Trace](local-ttft-trace-reading.md) · [Platform Acceptance Evidence](local-ttft-platform-evidence.json) · [Ticket 01](../issues/ttft-stage-telemetry/01-local-send-stage-observability.md) · [Ticket 02](../issues/ttft-stage-telemetry/02-queued-retry-and-failure-diagnostics.md)

This document covers only the deployment actions after telemetry is implemented: routing data to Beijing ARMS,
completing platform acceptance, gradual rollout, capacity verification and cost tracking. The telemetry contract
itself is in the parent contract; the query scope is in the query contract.

**Phase 0 is complete (2026-09-15):** the new service `zcode-local-ttft` Trace and Metric are queryable in Beijing
ARMS; percentiles, waterfall correlation, labels and the diagnostic definitions were all verified. Measurements:
`local-ttft-platform-evidence.json`. Local OTLP evidence: `local-ttft-evidence.json`,
`local-ttft-diagnostics-evidence.json`. Phases 1-3 are unfinished.

## Current state

| Gate                | Current state                                                                                                                                                                                                                                                         | Opened by                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Write address       | The write address is verified writable (the same base accepts traces and metrics). Desktop main does not create the metrics reader without an endpoint (`packages/desktop/src/main/localTtftExporter.ts:46`); the packaged build depends on build-time injection, a path not yet validated | Phase 1                                                                                            |
| Gray switch         | `rendererActionTrace.localTtftEnabled` defaults false (`packages/shared/src/rendererActionTrace.ts:21`)                                                                                                                                                                 | Phase 2: server-side `/api/v1/client/configs` delivery; a single machine can force it on via env var |
| Platform acceptance | Complete for query, waterfall, labels and warehouse delay; console UI visual check and retention/cost not done                                                                                                                                                          | Phase 3                                                                                            |

The gray switch is independent of the old Renderer/Agent Trace `enabled`/`sampleRatio`; it opens only TTFT without
changing old Trace sampling or parent-child ownership.

## Phase 0: direct connection to real ARMS from a local machine, platform acceptance (done 2026-09-15)

Platform acceptance does not depend on CI or gray delivery; a local dev direct connection settles the Ticket 01/02
platform items.

- [x] Use the ingestion values currently used by `zcode-cli-agent` (CI vars `ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT` /
  `ZCODE_PACKAGED_AGENT_OTEL_HEADERS`). The write key goes neither into the dashboard nor into this repo doc.
- [x] Confirm this endpoint is the OTLP base. Measured base is `/apm/trace/opentelemetry`; `base + /v1/traces` and
  `base + /v1/metrics` both return 200, and the separate `/apm/metric/opentelemetry/v1/metrics` is actually 404.
  The earlier worry that a base containing the trace segment makes metrics hit a non-existent URL does not hold;
  the concatenation at `packages/desktop/src/main/localTtftExporter.ts:31` works.
- [x] Confirm the backend accepts the metrics signal on the same endpoint. Conclusion: accepted, so no separate
  metrics-endpoint injection is needed in desktop main (the allow-list at
  `packages/desktop/src/main/desktopRuntimeEnv.ts:216` stays as is).
- [x] Use real controlled samples: two real E2E runs of `conversation-session-ttft-stages` (3/3 each) and one of
  `conversation-session-ttft-diagnostics` (6/6), 12 sends in total, with only the base endpoint set as online
  (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` not set separately). 85 forwards, all 200, no failure.
- [x] Trace acceptance: `service.name = zcode-local-ttft` queryable (was 0); `observation_id` without hyphens
  equals traceID; one send has 62 spans, root 701.70 ms vs six main stages' union 701.69 ms, `unattributed_ms=0`;
  `local_ttft.checkpoint`, `.start`, `.first_text` share the Trace root; `.started` point records have duration 0.
- [x] Actual metric series names carry **no unit suffix**; the query contract's `zcode_local_ttft_*` default names
  hold.
- [x] Total P50/P95, stage P95, preparation sub-stage P95 with matching `_count`, DELTA + `sum_over_time` hold.
  Stage sample count 18 = 3 sends x 6 stages, not inflated by attempts.
- [x] Diagnostic definitions (Ticket 02): `records` complete by kind (start 16 / first_output 12 / first_text 12 /
  excluded 4 / checkpoint 442); `excluded` splits cancelled / failed / guided; `attempt` splits failed retries and
  first output by role+outcome; `no_output.wait` records cancelled and failed; `preparation` covers context /
  hooks / persistence / mcp / tools / request_assembly / user_confirmation / retry_wait.
- [x] Labels are controlled and low-cardinality (app_version, os, provider, model, quality, send_mode,
  visibility, stage, role, outcome, kind); no correlation ID leaks into metric labels.
- [x] Warehouse visible delay: polling started right after the second run ended; Trace and Metric hit on the first
  poll (upper bound <5 s). This is an "visible at end" upper bound, not a per-condition precise delay.
- [x] Results written back to the Ticket 01 and Ticket 02 platform acceptance items; local tests and platform
  acceptance are recorded separately.
- [ ] **Not done:** visually confirm the waterfall rendering and navigation in the ARMS/Trace Explorer console. All
  checks so far read API data integrity only; console confirmation needs a login.

Side effect: 12 controlled sample sends were written into the production telemetry store; they can be excluded by
`provider="e2e-deepseek"`, `model="deepseek-v4-flash"`, which never appear in real user samples.

## Phase 1: packaged build with write configuration

Needs CI variable permission (release/CI owner).

- [ ] Confirm the CI variables are available in the target build. `resolveBuildPackagedAgentTelemetryEnv`
  (`packages/desktop/tsup.config.ts:84`) requires endpoint and headers as a pair, production must be HTTPS, and a
  missing variable on a release branch/tag fails the build directly. With the variables in place desktop main gets
  the metrics output automatically; no new build config is needed.
- [ ] Produce a dev/preview package and launch it once from Finder / Start Menu. An installed package starts
  without shell env vars, which is why the Agent historically fell silently into Noop (see the comment at
  `packages/desktop/src/main/desktopRuntimeEnv.ts:213`). This is the only path Phase 0 does not cover: Phase 0 runs
  runtime env injection.
- [x] ~~If Phase 0 shows metrics need a separate endpoint, finish that channel change before packaging.~~ Phase 0
  confirmed the same base accepts metrics; no change needed.

## Phase 2: gradual rollout

- [ ] Server `GET /api/v1/client/configs` returns `data.configs.rendererActionTrace.localTtftEnabled = true`
  (parsing: `packages/desktop/src/main/rendererActionTraceRollout.ts:53`). The request carries `app_version` and
  `platform`, so audiences can be cut by version/platform.
- [ ] Start with a small group. Within the gray release collection is bounded and full, with no active sampling;
  observe volume per Phase 3 before expanding.
- [ ] Internal verification forces it on per machine with `ZCODE_LOCAL_TTFT_ENABLED=1`
  (`packages/desktop/src/main/rendererActionTraceIpc.ts:123`) without editing the online config.
- [ ] After the gray launch confirm that legacy business completion, RUM TTFT and send-funnel counts are
  unchanged.

## Phase 3: capacity, cost and retention

Thresholds before expanding the gray release; all must be verified on ARMS, document estimates cannot replace it.

- [ ] Series count: 10 Histograms + 2 Counters, 15 explicit buckets + `+Inf` + sum/count, theoretical limit about
  46,592 series per resource group. Also check the backend resource-label mapping and whether overflow series are
  produced.
- [ ] Cardinality not capped: per-instrument limit 26 (as written here; the query contract says 256), provider/model
  at most 16 groups (`packages/desktop/src/main/localTtftExporter.ts:71`). Capped means lost discriminability and
  entry into `other`.
- [ ] `zcode.local_ttft.dropped` is 0 online; non-zero means the queue or capacity boundary needs adjusting;
  distinguish reasons by queue full, eviction capacity, transport timeout and truncation.
- [ ] Retention reaches the target: detail 7 days, aggregates at least 30 days, plus an actual cost estimate. The
  parent contract marks this item as a deployment condition to verify.

## Phase 4: dashboard deployment

- [ ] Import `dashboards/local-ttft.json` and replace the `total_metric` / `stage_metric` variables with the actual
  metric names verified in Phase 0.
- [ ] The default experience view uses `quality="complete"` and `visibility="foreground"`; `missing`,
  `clock_invalid` and observation series go only into the diagnostic view. Observation-series labels are the state
  when that stage was observed, not proof that the message stayed foreground; mixing them pollutes the default
  distribution.
- [ ] Each percentile chart carries `_count` of the same filter and time window. Do not add P95s or derive stage
  P95 as total P95 minus model P95.

## Local reproduction entry

Without connecting to real ARMS, verify the local output via the
[Local reproduction](local-ttft-queries.md#local-reproduction) section of the query contract: first start
`packages/desktop/scripts/ttft-otlp-receiver.mjs` (listens only on localhost:14318), then run the two candidate
cases `conversation-session-ttft-stages` / `conversation-session-ttft-diagnostics`. This path proves only the final
OTLP contract and is not platform acceptance.

## Not in this checklist

- TTFT collection for desktop remote workspaces and mobile/web remote control (parent contract, Out of Scope).
- The CLI full-unit-test failures recorded in Ticket 01 (442 files passed / 76 failed, not itemized by origin; the
  stale scenario also fails at the starting HEAD). They do not block platform acceptance, but overall completion
  needs separate disclosure.
- Windows / Linux real-machine and mobile remote-control E2E evidence.
