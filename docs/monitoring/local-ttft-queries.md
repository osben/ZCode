# Local TTFT Queries & Acceptance

Status: in-progress

[Parent Contract](ttft-stage-telemetry.md) · [Grafana Dashboard Template](dashboards/local-ttft.json) · [How to Read a Trace](local-ttft-trace-reading.md) · [Launch Checklist](local-ttft-rollout-checklist.md)

Local OTLP data verification and ARMS platform acceptance are recorded separately. The Beijing ARMS project can
query the existing zcode-cli-agent / zcode-desktop-renderer Traces and custom Metrics. Platform acceptance of the
new service `zcode-local-ttft` was completed on 2026-09-15: Trace and Metric ingestion, quantile queries,
waterfall correlation and the diagnostic definitions were all verified; see
[platform evidence](local-ttft-platform-evidence.json). Still open: visual confirmation of the waterfall in the
console UI, the packaged-build compile-time injection write path, 7-day Trace / 30-day Metric retention and the
actual cost.

## Ingestion

Reuse `OTEL_EXPORTER_OTLP_ENDPOINT` and each signal's endpoint/headers; never put write keys in the dashboard.
Gray release is controlled by the boolean `rendererActionTrace.localTtftEnabled` in the existing client configs
(default false); the old Trace enabled/sampleRatio does not decide new TTFT sampling. Local app diagnostics can set
`ZCODE_LOCAL_TTFT_ENABLED=1`; old Renderer/Agent Trace sampling is unchanged.

Dedicated Metrics: `zcode.local_ttft.duration`, `zcode.local_ttft.stage.duration`,
`zcode.local_ttft.first_text.duration`, all millisecond Histograms with OTLP DELTA temporality. Main-sample labels
are provider, model, quality, app_version, os; the stage Histogram adds the fixed stage. Each exporter keeps at
most 16 provider/model combinations (the rest become `other`) and each instrument's aggregation cardinality is
capped at 256. High-cardinality correlation goes only into Trace. The default-experience dashboard selects
quality=complete; missing/clock_invalid can be queried separately and must not enter the complete stage
distribution. Quality semantics: clock_invalid only means a clock anomaly was detected (negative interval,
sleep/pause, wall-clock drift beyond bound); missing or expired calibration only makes cross-process stages
missing (recorded `missing`) while same-process stages and total TTFT stay reliable.

ARMS built-in business metrics and the dedicated OTel Histogram differ in storage/aggregation, so built-in Gauge
query formulas must not be applied. [ARMS metrics doc](https://www.alibabacloud.com/help/en/arms/application-monitoring/developer-reference/application-monitoring-metrics)

## PromQL templates

After importing the dashboard, first check the actual OTel → Prometheus names on the target Prometheus data
source. The Beijing tenant maps OTel metrics without unit suffixes (e.g. `zcode.agent.step.duration` with unit=s
maps to `zcode_agent_step_duration`), so templates default to `zcode_local_ttft_duration`. Verified on 2026-09-15
with real new samples: the new metrics also have no unit suffix and the default names hold; for another tenant or
Collector change the actual names through `total_metric`/`stage_metric`.

```promql
histogram_quantile(0.50, sum by (le) (
  sum_over_time(zcode_local_ttft_duration_bucket{quality="complete"}[5m])
))
histogram_quantile(0.95, sum by (le, stage) (
  sum_over_time(zcode_local_ttft_stage_duration_bucket{quality="complete"}[5m])
))
sum by (stage) (
  sum_over_time(zcode_local_ttft_stage_duration_count{quality="complete"}[1h])
)
```

This exporter emits DELTA Histograms. The ARMS custom time-series store keeps each report's interval value (the
same existing count series was observed going 2 → 1 → 1), so the dashboard accumulates interval samples with
`sum_over_time`. Do not treat these interval values as cumulative Counters and apply rate/increase; for another
Collector that converts to cumulative Counters, switch to rate/increase and re-accept.

The SLS SQL entry can run the same PromQL:

```sql
* | select promql_query('histogram_quantile(0.95, sum by (le,stage) (sum_over_time(zcode_local_ttft_stage_duration_bucket{quality="complete"}[5m])))') from metrics limit 20
```

The SQL+PromQL entry was verified against the existing `zcode_agent_step_duration_bucket`; that does not by itself
mean new TTFT is ingested. [SLS time-series query syntax](https://help.aliyun.com/en/sls/time-metric-data-query-and-analysis-syntax)

For total P95 change 0.50 to 0.95 in the first query; for stage P50 change the second to 0.50. Every quantile chart
carries a same-range count. Histogram quantiles are bucket interpolations whose error depends on the adjacent
bucket width, not exact raw-sample quantiles; never add P95s or subtract P95s of different Histograms.
[Prometheus histogram_quantile](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile)

Bucket boundaries (ms): 1, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000 and +Inf.
Invalid intervals are omitted with a quality mark, never filled with zero. `zcode.local_ttft.records` observes
start, first_output, first_text, no_text, excluded; `zcode.local_ttft.dropped` distinguishes Renderer capacity,
Main queue_full, invalid, oversized, trace_export.

## Per-message waterfall

Field units, span naming and item-by-item reading: [How to Read a Trace](local-ttft-trace-reading.md).

The Trace service.name is `zcode-local-ttft`. Filter exactly by `observation_id` to get one send; its value with
hyphens removed is the trace ID. The root `local_ttft` start/end use the same Renderer monotonic clock. The six
child spans keep original intervals; ACK latency is not mixed into main stages. `command_id`/`input_id`/
`query_id`, runtime `turn_id`, `product_turn_id`, `logical_call_id` and `request_id` are only for Trace
correlation; `cli_instance_id` distinguishes processes. `local_ttft.start`, `local_ttft.first_text` and
`local_ttft.no_text` are independent checkpoints of the same Trace and add no main TTFT samples.

Clock calibration uses the existing command query RPC returning CLI receive/send monotonic epoch times, which with
the Renderer round trip gives offset/error. Maximum allowed error 10 ms, validity 60 s; sending never waits for
calibration, and expired or missing calibration is explicitly marked. Besides refreshing with the transport
handshake, the Renderer re-probes when it receives a CLI checkpoint or actual content frame with expired
calibration, so queued or slow sends have valid calibration before first output; a probe already in flight is not
repeated. Valid cross-process stages are reconciled by interval; missing stages are not pretended to have run. The
model request keeps only the overall boundary and does not guess an internal network/queue/inference split.

## Local reproduction

Run `node packages/desktop/scripts/ttft-otlp-receiver.mjs` first (it listens only on localhost:14318 and keeps at
most 512 batches). Then run:

```sh
ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_LOCAL_TTFT_ENABLED=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318 \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-ttft-stages.json \
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-ttft-stages.test.ts'
```

This candidate case drives the real Composer and asserts the last received protobuf Trace/Metric. The second
scenario injects a 250 ms command delay and 7 s ACK delay at the single public transport seam; the model fixture
gives first reasoning at 250 ms and first text at 8 s, and checks that the root arrives before ACK/terminal and the
known delays are attributed correctly. The fault seam is active only in E2E builds and fabricates no facts.

## Current platform location

- region: `cn-beijing`
- project: `arms-project-placeholder`
- Trace: `logstore-tracing`
- Metric: `metricstore-apm-metrics-custom`
- Platform acceptance completed 2026-09-15: Trace and Metric of the new service `zcode-local-ttft` are ingested
  and queryable; metric names carry no unit suffix (the default names in this document hold); DELTA +
  `sum_over_time` holds; `observation_id` without hyphens equals the traceID; the six-stage union of one send
  reconciles with the root duration. Measurements: [platform evidence](local-ttft-platform-evidence.json); deployment
  and remaining steps: [rollout checklist](local-ttft-rollout-checklist.md). Console waterfall visual check,
  retention and cost remain unverified.
- [Local real-output evidence](local-ttft-evidence.json) keeps counts/bucket estimates and measured error for 3
  sends, 6 stages and 8 Histograms.

## Ticket 02: Queueing, preparation, retry and unclosed

[Implementation and acceptance](../issues/ttft-stage-telemetry/02-queued-retry-and-failure-diagnostics.md). It
reuses the same `observation_id` and OTLP output; `command_id/input_id` point at the original accepted input, and
queue edits/send-now do not switch to the operation command. A confirmation-dialog retry only replaces the
already-rejected command binding and keeps the first-submit clock and observation ID. An immediate guide is
classified `guided` and records no independent successful TTFT.

### Statistical units

| Metric                                              | What one sample means                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `zcode.local_ttft.duration`                         | One successful first output, including queueing and user-confirmation wait                                                   |
| `zcode.local_ttft.execution.duration`               | From execution start to the actual first output; produced only when cross-process alignment is reliable                      |
| `zcode.local_ttft.system.duration`                  | Total TTFT of the same message minus the explicit confirmation wait, not derived by subtracting quantiles                    |
| `zcode.local_ttft.stage.duration`                   | One main stage of a successful input; each stage is recorded once after complete quality is confirmed                        |
| `zcode.local_ttft.preparation.duration`             | One preparation/confirmation/retry-wait interval before first output of a successful input; repeats count separately         |
| `zcode.local_ttft.stage.observation.duration`       | One completed main stage, without waiting for root closure; includes inputs that end with no output                          |
| `zcode.local_ttft.preparation.observation.duration` | One completed preparation/confirmation/retry-wait interval, without waiting for root closure                                 |
| `zcode.local_ttft.attempt.duration`                 | One physical attempt before first output, until failure, completion or first output; role distinguishes response/preparation |
| `zcode.local_ttft.no_output.wait`                   | Waited time before an explicit failed/cancelled/rejected/interrupted outcome with no first output                            |
| `zcode.local_ttft.records`                          | One de-duplicated lifecycle record; total inputs = kind=start, never sum all kinds as a message count                        |

`send_mode=idle|queued|guided`; `visibility=foreground|background|background_returned`. The default experience must
add `visibility="foreground",quality="complete"`; background, returned-to-foreground, unreliable-clock and
missing-stage data are viewed in diagnostic views. **Labels of the observation series are the state when that stage
was observed**, do not mean the message was foreground throughout, and cannot replace the default experience
distribution. Main TTFT is recorded at first output and is neither rewritten nor duplicated for late stages;
later-completed stages can enter the complete stage distribution and the Trace checkpoint shows the updated
quality.

Every quantile chart also shows `_count` of the same filter/window. Preparation intervals and model attempts are
interval observation units: their number is not the user-input count and parallel interval durations must not be
added as main-stage wall time. Queries still use `sum_over_time` per the DELTA time-series definition verified for
ticket 01.

```promql
# Foreground only: total P95 and sample count by idle/queued
histogram_quantile(0.95, sum by (le,send_mode) (sum_over_time(zcode_local_ttft_duration_bucket{quality="complete",visibility="foreground"}[5m])))
sum by (send_mode) (sum_over_time(zcode_local_ttft_duration_count{quality="complete",visibility="foreground"}[5m]))
# Preparation sub-stage P95 and interval count
histogram_quantile(0.95, sum by (le,stage) (sum_over_time(zcode_local_ttft_preparation_duration_bucket{quality="complete",visibility="foreground"}[5m])))
sum by (stage) (sum_over_time(zcode_local_ttft_preparation_duration_count{quality="complete",visibility="foreground"}[5m]))
# Attempt outcomes and counts; response only, compact not mixed in
sum by (outcome) (sum_over_time(zcode_local_ttft_attempt_duration_count{role="response"}[1h]))
# Count of explicit failed/cancelled/rejected/interrupted before first output, and the ratio over all observed inputs
sum by (outcome) (sum_over_time(zcode_local_ttft_records{kind="excluded",outcome=~"failed|cancelled|rejected|interrupted"}[1h]))
sum by (outcome) (sum_over_time(zcode_local_ttft_records{kind="excluded",outcome=~"failed|cancelled|rejected|interrupted"}[1h])) / scalar(sum(sum_over_time(zcode_local_ttft_records{kind="start"}[1h])))
```

The denominator includes unclosed inputs and a window cut makes the start/end sets inconsistent; the exact outcome
ratio of one batch should be computed by joining on the Trace observation_id. A `start - terminal` window
difference must not be read as a timeout rate.

### Waterfall and unclosed

- `local_ttft.start` is emitted at submit; `local_ttft.checkpoint` is exported when facts change, so it is queryable
  even when the root has not ended. `local_ttft.<main stage>`, `local_ttft.prepare.<sub-stage>`,
  `local_ttft.attempt`, `local_ttft.retry_wait` and `local_ttft.user_confirmation` use stable Span identities and
  each completed interval is exported once.
- `.started` is a point record of a stage start with `detail_outcome=unclosed`, not a zero-duration successful
  stage. A missing end keeps an open interval; a Trace with only start/partial stages may still be running or have
  lost its terminal.
- `unattributed_ms` reconciles against the **union** of all reliable known intervals within the first-output
  boundary; parallel time counts once, missing stages are not zero-filled, and the difference is not blamed on
  network or model. `missing_stages`, `truncated`, `clock_source`, `clock_error_ms` help tell missing, truncated and
  unreliable alignment apart.
- With no explicit outcome, the 5-minute observation cleanup leaves only `unclosed`; an explicit runtime
  unavailable/exit is recorded `interrupted`. Force-kill promises no zero loss and fabricates no terminal/stage.
  An error or exit after first output does not reverse main TTFT.
- Querying unclosed items requires joining start with first_output / explicit excluded results by observation_id
  in the Trace; a missing root alone must not be judged failed/timeout from the query window. Insufficient
  retention, or a query window not covering the first submit, must be marked as window truncation.

### Clock, resources and compatibility

The Renderer click clock and the CLI stages each use their own monotonic clock; alignment stays RTT/2 <= 10 ms with
60 s validity, re-calibrated from checkpoints/content frames once expired. A monotonic-vs-wall accumulated
difference over 100 ms, or a sampled pause over 5 s, marks unreliable; same-process stages already completed and
exported reliably before stay independently queryable. Renderer state comes from actual window
focus/blur/visibility with at most 32 changes, and background collection continues. When the platform cannot tell
sleep from a debug pause, only a timing anomaly is marked without guessing the cause.

Per record at most 64 detailed intervals and 6 main stages; Renderer/CLI each at most 128 in-flight observations,
the CLI also keeps 128 completed facts for frame dispatch; the Renderer buffers 128 records in batches of 32; the
Main queue is 32 batches of 256 KiB each with a 3 s network timeout. The exporter de-duplicates whole groups by
observation identity: at most 1024 observations with 512 fact identities each, and retransmits outside the
5-minute window are explicitly dropped (no per-key eviction that would regenerate main samples). `dropped`
distinguishes queue full, window/dedupe capacity, transport timeout and truncation. In the gray release the old
10% sampling is not relied on; the resource drops above can still lose data, so zero loss is not claimed.

Each exporter keeps at most 16 controlled provider/model groups (the rest `other`); each Histogram/Counter
aggregation combination is capped at 256. With 10 Histograms and 2 Counters, 15 explicit buckets, +Inf, sum/count,
the theoretical upper bound is about 46,592 series per resource group; backend resource-label mapping and overflow
series must also be checked. Correlation IDs, requestId, workspace, path and user never enter metric labels; real
sample cardinality is in the run evidence. Before widening the gray release, capacity, cost and the 7-day detail /
30-day aggregate retention must still be confirmed in ARMS.

Detailed notifications are exposed only on the local desktop-continuous attachment; remote identity,
remoteSessionId and web-remote-replayable have no local TTFT. New fields do not change business commands and
content without a ttft context; the CLI and Renderer use the strict telemetry schema of the same packaged version;
legacy business events, RUM and the accepted-input FIFO are unchanged.

### Re-verification

Replace the spec and case-local fixture in the command above with `conversation-session-ttft-diagnostics`; the same
`ttft-otlp-receiver.mjs` is reused. The candidate contains a real user-config Hook (300 ms), HTTP 503 → success
replay, HTTP 400, queue/confirmation/guide and real window minimize/restore. Performance numbers are in the run's
`ttft-diagnostics-performance.json`; they are test-time observations, not an A/B overhead conclusion for gray
off/on. The macOS controlled process test uses real SIGSTOP/SIGCONT/SIGKILL; Windows skips the signal tests and
needs separate platform evidence.

2026-09-15 platform acceptance: `conversation-session-ttft-stages` (2 runs, 3/3 each) and
`conversation-session-ttft-diagnostics` (6/6) wrote 12 sends to the Beijing ARMS project, all queryable. `records`
are complete by kind, `excluded` splits cancelled/failed/guided, `attempt` splits failed retries from first output
by role+outcome, `no_output.wait` and the 8 `preparation` sub-stages all have samples, and the default experience
filter (`quality="complete",visibility="foreground"`) returns idle 4 and queued 1. Detail and aggregates are
queryable at run end (upper bound <5 s). All returned values: [platform evidence](local-ttft-platform-evidence.json).
Console waterfall visual check, retention and cost configuration remain unverified.
