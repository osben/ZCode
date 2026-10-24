# 01 — TTFT stage metrics and waterfall for a plain send

**What to build:** For a desktop local workspace that stays in the foreground, sends while idle and needs no
retry, performance analysts can see the full main-stage durations from send click to first valid output,
P50/P95, and a per-message waterfall. Text, reasoning and tool call arriving first all close correctly;
first-text time is recorded separately. The ticket runs through the real send, cross-process correlation,
stage capture, final OTLP export, queries and E2E, and can be demoed and accepted independently.

**Blocked by:** None.

**Status:** in-progress

**Parent:** [Desktop local message TTFT stage telemetry](../../monitoring/ttft-stage-telemetry.md)

## Acceptance criteria

- [x] Supported sample: desktop local, continuously foreground, idle send, no retry. Unsupported paths
  (queued, immediate guide, failed/cancelled) have an explicit classification and bounded cleanup and are
  never counted as plain successes; their full diagnostics belong to ticket 02.
- [x] A real click or Enter submit that passes the gate creates a stable observation correlation spanning
  Renderer, window Local Host, CLI and actual session-content return. The shared protocol uses strict types
  and runtime validation and stays backward compatible; Host adds no second business queue and Main holds no
  task business state.
- [x] The correlation locates command/input/query, turn and model request; output before ACK is attributed
  correctly; legal reordering and duplicates never create a second main TTFT or Metric. Independent sessions,
  workspaces and process instances do not cross.
- [x] Six main stages are recorded: Renderer send preparation, command delivery and CLI acceptance, waiting
  for execution, execution and request preparation, model request, first-output return. The wait from CLI
  receiving the command to obtaining the admission gate is not omitted; ACK round trip and execution may run
  in parallel and are not double-counted.
- [x] Request preparation is first recorded as one complete main stage (hooks, persistence, compaction, MCP
  breakdown is ticket 02). Preparation time must not be missing, and an internal compaction model request is
  never mistaken for the main response's first output.
- [x] First output comes from actual content receipt in the originating Renderer and accepts non-empty
  displayable text, reasoning or a tool call, recording `first_output_kind`. Empty block/start, heartbeats,
  status notices and side-channel telemetry do not trigger it. Old turns and subtask side-channel content do
  not claim this input's first response.
- [x] First output completes the main TTFT and goes to async export without waiting for the turn terminal;
  first text is still observed lightly and reported separately if late; end-without-text has its own status;
  later errors do not reverse an established first output.
- [x] End to end uses the originating Renderer's clock; each process uses a monotonic clock internally. The
  cross-process alignment error has a measured value and an executable threshold so tens-of-millisecond stages
  stay distinguishable; invalid or unreliable intervals are never clamped to zero.
- [x] Trace keeps real stage intervals and causality; main stages reconcile against the actual timeline,
  overlaps are not added twice, missing and unattributed intervals are visible, un-run stages are not zero.
  No unsupported split of model-service network, queueing or inference.
- [x] The same stage facts produce a dedicated OTel Metric and Trace through the existing OTLP export
  facility. Main TTFT is counted once per send; repeated model attempts or stages do not inflate message
  samples.
- [x] Dedicated millisecond Histogram buckets for short stages; queries show sample count and bucket
  precision and give total TTFT and per-stage P50/P95. Quantiles are never added, and stage time is never
  derived by subtracting model P95 from total P95.
- [x] Base ARMS queries and a dashboard config filter by stage, model/provider, app version and OS using
  controlled combinations, and open the per-message waterfall via the correlation ID. High-cardinality message,
  trace or workspace identifiers never enter Metric labels.
- [x] The gray-release enablement decision is consistent across the chain; bounded TTFT detail for the
  enabled population is not sampled and does not depend on the old CLI 10% Trace or independent Renderer
  sampling. When off, no new collection starts; old Agent Trace parentage and sampling are unchanged.
- [x] Stage records, memory and the export queue are bounded; export timeout, rejection or a full queue never
  blocks sending or output, and drops/truncation are observable. No per-token network reporting; no body, file
  content, raw path, credential or request header/body is collected.
- [x] Desktop stays on desktop-continuous. Remote workspaces, mobile/Web, history hydration, replayable
  recovery and automated tasks produce no local user TTFT; legacy business events, RUM TTFT and the send
  funnel keep their definitions and counts.
- [x] The E2E "real desktop Composer send → decoded result at the final OTLP receiver" was written before the
  implementation, reusing the existing conversation replay and OTLP HTTP receiver, and checks final
  Trace/Metric rather than internal calls.
- [x] E2E covers text/reasoning/tool first, empty start event, late first text, first output before ACK, and
  attribution after injecting a known delay into a main stage; lower-level tests only cover clock,
  deduplication and protocol boundaries.
- [x] Controlled samples verify ARMS base quantiles and per-message correlation display, with real or test
  export evidence; platform acceptance and local tests are recorded separately. Done 2026-09-15: the new
  service is ingested, total P50 / stage P95 are queryable, `observation_id` with hyphens removed equals the
  traceID, and a 62-span message's six-stage union reconciles with the root duration
  ([platform-evidence](../../monitoring/local-ttft-platform-evidence.json)). Visual confirmation of the
  waterfall in the console UI is still not done.
- [ ] Finish related E2E/unit tests, typecheck, lint and architecture gate, and leave notes on the stage
  contract, clock error, buckets and data-volume limits. Any small pre-refactor happens before wiring and
  keeps behavior; no broad refactor task.

## Scope hand-off

The protocol, correlation, timing quality, export and final-OTLP test capability form a reusable boundary in
this ticket. [Ticket 02](02-queued-retry-and-failure-diagnostics.md) extends the same contract with
preparation sub-stages, queue/retry support, exception scenarios, the full diagnostics dashboard and gray
rollout acceptance. Together they implement the parent spec; this ticket's narrow support does not mean the
whole requirement is done and does not extend to desktop remote or mobile remote control.

## Implementation and verification (2026-09-14)

Local implementation and query configuration are complete; platform final acceptance and the full CLI run are
not, so the ticket stays in-progress.

- Artifacts: [stage contract and queries](../../monitoring/local-ttft-queries.md),
  [dashboard config](../../monitoring/dashboards/local-ttft.json),
  [final OTLP evidence](../../monitoring/local-ttft-evidence.json).
- Real desktop E2E 3/3 (text/reasoning/tool first; empty start; late text; content before ACK; known command
  and model delay attribution); main TTFT and six-stage Histograms each have 3 samples, no per-attempt
  inflation. Final runtime clock error bound 3.125 ms (threshold 10 ms); all three kinds quality=complete;
  unfocused runs are not mixed into success samples.
- Root unit tests (1707 files, 14991 tests passed, 14 skipped), root typecheck, E2E typecheck, lint and
  architecture gate pass.
- CLI full direct Vitest: 442 files passed / 76 failed; 5872 tests passed / 187 failed (default turbo entry
  missing here). The CLI full suite is not claimed green and failures were not attributed one by one; the
  affected gateway stale scenario also fails at the starting HEAD (reproduced via isolated source loading).
- A full Desktop tsc finds pre-existing rootDir/global-declaration errors; the new exporter passes strict
  typecheck alone.
- Cases remain manual-review/pending; no Windows/Linux real-machine or mobile remote-control E2E evidence.

## Platform acceptance (2026-09-15)

This supersedes the earlier "new service has 0 samples". With ingestion values from CI variables, two runs of
`conversation-session-ttft-stages` (3/3 each) wrote samples to the Beijing ARMS project, all queryable.

- Endpoint: base `/apm/trace/opentelemetry` accepts both `/v1/traces` and `/v1/metrics`; a separate metric base
  is 404, so Desktop main needs no new metrics-endpoint injection channel.
- Metric names carry no unit suffix (the contract's default names hold); DELTA + `sum_over_time` holds. Total
  P50 1500 ms and all six stage P95; stage samples 18 = 3 sends x 6 stages.
- Waterfall: `observation_id` without hyphens equals traceID; 62 spans, root 701.70 ms vs six-stage union
  701.69 ms, `unattributed_ms=0`, `clock_error_ms=5.02`.
- Detail and aggregates are queryable at run end (upper bound <5 s), not an exact per-item measurement.
- Not done: console-UI waterfall visual confirmation, packaged-build compile-time injection write path,
  retention and cost; CLI full-suite failures and Windows/Linux evidence remain.

Details: [rollout checklist](../../monitoring/local-ttft-rollout-checklist.md) and
[platform evidence](../../monitoring/local-ttft-platform-evidence.json).

## Review outcomes

- Standards: telemetry error isolation, an invalid-Metrics-URL startup-failure risk and diagnostic-callback
  isolation were fixed; the separate Metrics header/endpoint joined the private-capture and tool-env scrub list.
- Spec: fixed late execution-preparation boundary, missed complete tool events, rejected completion for unknown
  turn IDs, premature terminal cleanup, misclassified recovery samples and failures mislabeled as retry. The
  execution-entry monotonic time flows through the raw TurnStarted only for the new TTFT and does not extend
  the old strict telemetry fact.
- A coverage audit failed on stale existing D19/I74/I75 automation references and generated decision docs;
  this ticket's pending fixture metadata has 0 rejected and its fixture check passes. Unrelated statistics/
  decision docs were not rewritten.
- Calibration workspace-isolation regression fixed: a clock-only request does not take the Host business-query
  workspace binding, and the protocol layer rejects session-command queries for it.
