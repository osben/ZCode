# 02 — Stage attribution for queued, retried and abnormal sends

**What to build:** On top of the plain-send observation chain, let analysts explain real slow messages:
expand request-preparation sub-stages; distinguish queueing, retry, user confirmation, failure/cancel and
foreground/background effects; inspect unclosed messages and data quality; and analyze percentiles, outcome
ratios and waterfalls of these scenarios in ARMS.

**Blocked by:** [01 — TTFT stage metrics and waterfall for a plain send](01-local-send-stage-observability.md).
Its stable correlation, time contract, export schema and final OTLP test receiver are real prerequisites.

**Status:** in-progress

**Parent:** [Desktop local message TTFT stage telemetry](../../monitoring/ttft-stage-telemetry.md)

## Acceptance criteria

- [x] Continue ticket 01's observation and export contract; complex scenarios also go through the real send,
  CLI authoritative lifecycle, content return and final OTLP data, with no second queue, correlation key or
  parallel exporter.
- [x] Expand hooks, context loading, persistence, compaction, MCP/tool preparation and request assembly that
  actually happen before first output, with sub-stage distributions and waterfall detail. Concurrent,
  duplicate and un-run sub-stages appear as real facts; the sum of sub-stages is not the main-stage wall time.
- [x] Distinguish preparation model calls such as internal compaction from the model call that produces the
  user's first response; interleaved preparation and retry keep their real order; an internal model's first
  content is never recorded as the user's first output.
- [x] A queued send promoted to run keeps the original send correlation; queue edits and send-now do not
  replace the original input attribution. Total TTFT including queueing, queue wait, and start-of-execution to
  first output are shown separately; idle and queued messages are counted independently.
- [x] Queue second confirmation keeps the first-submit start without creating a new send record; the user's
  wait in the dialog is marked separately so pure-system analysis can exclude it. An immediate guide input
  records its send result or its own category, does not take other inputs' output and is not mixed into plain
  TTFT percentiles.
- [x] After a model failure and retry, physical attempts and retry waits attach to the same send, and a new
  requestId does not reset the main start. Multiple attempts yield one main TTFT; later tool-loop requests are
  not mixed into the first-response statistics.
- [x] Explicit failure, rejection, cancel or interrupt before first output records the result, time waited and
  completed stages, with counts and ratios by type. No-first-output samples never enter the success duration
  distribution as 0 or -1; a failure after first output does not reverse main TTFT.
- [x] Bounded checkpoints are submitted asynchronously at send start and stage completion so exported stages
  are queryable while the root is unclosed. No dependence on the whole root span ending; no per-token
  checkpoint.
- [x] Records with only a start or partial stages show as unclosed (maybe still running or interrupted); with
  no explicit evidence they are not judged failed or timed out because they exceed the query window. A killed
  process does not promise zero loss and missing stages are not fabricated.
- [x] Terminal/stage reordering, duplicate transport and late legal facts merge by stable identity without
  duplicate Metric samples. Multi-session/window/workspace/process tests prove no mis-binding to old turns,
  other inputs or subtask side-channel output.
- [x] Collection continues in the background, saving necessary state changes; continuously-foreground differs
  from backgrounded-and-returned. The default experience query uses only continuously foreground, reliably
  timed samples; diagnostic queries can see all.
- [x] Machine sleep, pause, clock jumps or out-of-bound cross-process error mark data quality, never produce
  negative durations or forced zero clamps. Reliable same-process stages may stay; unreliable cross-process
  samples are not mixed into precise stage distributions.
- [x] The waterfall shows parallel, missing, truncated and unattributed intervals and reconciles the real
  interval union with total time; the difference is not forced onto model or network time.
- [x] Extend 01's queries and dashboard with views for preparation sub-stages, idle/queued, foreground/
  background, retry outcome, no-first-output outcome, unclosed and quality classes. Percentiles show sample
  counts; the statistical unit (cumulative, stage or attempt observation) is explicit.
- [x] Bounded stage detail and statistics for the gray population stay fully collected; foreground/background
  and abnormal paths are not dropped by old sampling config; label combinations and series counts are bounded;
  no message, trace, workspace or user correlation in metric labels.
- [x] Real desktop E2E covers queue and promotion, second confirmation, immediate-guide isolation, first
  output after retry, failure/cancel, preparation sub-stage delay and return from background, with attribution
  verified from final OTLP data, reusing 01's receiver and model replay without a test-only business
  interface.
- [x] Process-integration or low-level controlled tests cover exit, kill, missing terminal, duplicate/
  reordered delivery, parallel intervals and alignment error; real-run evidence and simulated results are
  distinguished, and mock success is not described as real-machine verification.
- [x] Exporter timeout, full queue, drops and truncation keep the business running with bounded resources;
  extended scenarios do not change legacy business/RUM counts or remote, mobile or replayable recovery behavior.
- [ ] One real desktop run aligning submit, actual content receipt, stage records and final export, measuring
  message latency, main-thread load, memory, event volume and label cardinality. Core verification covers
  macOS, Windows and Linux; unfinished platforms stay as explicit to-do.
- [x] ARMS verification of full percentile queries, message correlation, waterfall display and data
  visibility latency. Done 2026-09-15 on the API side: default-experience percentiles, preparation sub-stage
  P95, `records`/`excluded`/`attempt`/`no_output.wait` all queryable; detail and aggregates visible at run end
  (upper bound <5 s). Console-UI waterfall visual confirmation is not done.
- [ ] Verify actual ARMS permissions, capacity, cost and retention (target: detail 7 days, aggregates at least
  30 days; existing configuration that meets the target is kept). While unverified, keep the item open and do
  not widen to all-user rollout.
- [ ] Pass related E2E/unit tests, typecheck, lint and architecture gate; complete the stage and query usage
  notes; check the parent spec acceptance matrix item by item and state the actual results for local tests,
  platform verification and rollout conditions.

## Completion boundary

After this ticket, both tickets cover the parent spec's desktop-local scope. Desktop remote, mobile/Web TTFT,
model-service internal stages, React paint time and a new in-product diagnostics page stay out of scope; no
delivery gap depends on a third "wiring" or "test" ticket. If platform permission, retention or cross-platform
verification cannot be completed, leave the unchecked item with the concrete reason; "implementation done" is
not "all acceptance conditions met".

## Implementation contract (2026-09-14)

Continuing from 01's implementation was allowed; 01's platform acceptance and pre-existing CLI failures are not
treated as done.

- Test boundary: real Composer → CLI → actual content → final OTLP; controlled tests cover the public
  interfaces of recorder/observer/exporter. Only affected unit tests are run.
- The Renderer is the sole owner of the click clock, confirmation wait, foreground/background history and
  first-content receipt; the CLI recorder only subscribes to execution facts of the original command/input and
  keeps no business queue. Queue edits and send-now do not replace the observation ID.
- A strictly schema-typed, bounded stage notification is added along the existing V4 stdio/service chain; it
  is only a checkpoint and never triggers first output (actual first output is decided by the continuous
  content frame). Remote identity and replayable do not enable local TTFT; owner/lease/queue behavior is
  unchanged.
- Core publishes real intervals through an optional input-level preparation observation interface in
  contracts; with no subscriber nothing is timed. Repeated/parallel preparation uses independent stage IDs,
  internal model calls are separate from the main attempt, and preparation collection stops after first
  output.
- Root, main stages, preparation intervals, attempts and foreground/background changes use stable identities;
  checkpoints and late legal facts may complete Trace/stage statistics but never duplicate main TTFT. First
  output before terminal is not reversed; unknown disappearance or observation expiry only marks unclosed, not
  timed-out failure.
- Export stays bounded and async; a completed stage yields Trace/Metric independently and is queryable before
  the root ends. The stage union reconciles time; missing/overlap/truncation/clock anomalies are marked.

```mermaid
sequenceDiagram
  participant R as Renderer observer
  participant C as CLI CommandInbox / recorder
  participant P as Core / Model
  participant O as Existing OTLP exporter
  R->>O: start checkpoint
  R->>R: optional confirmation wait (original start)
  R->>C: original command/input + observationId
  C->>P: FIFO execution
  P-->>C: preparation interval / attempt / retry / explicit terminal
  C-->>R: bounded stage notification (not counted as output)
  R->>O: completed-stage checkpoint
  P-->>R: actual continuous content of the original turn
  R->>O: one main TTFT; first text may follow
```

ARMS write/permission/retention/cost, Windows/Linux real machines and wider gray rollout each keep their own
acceptance and are not satisfied by the local receiver.

## Implementation and verification (2026-09-14)

Local implementation is complete; the ticket stays **in-progress**: Windows/Linux real machines (criterion
19), platform acceptance (20-21) and pre-existing CLI failures (22) are unmet. The first 18 checks mean local
code and automated/data contracts are done, not ARMS display acceptance.

- Artifacts: [query/statistical-unit/resource contract](../../monitoring/local-ttft-queries.md),
  [dashboard template](../../monitoring/dashboards/local-ttft.json),
  [real desktop output and performance evidence](../../monitoring/local-ttft-diagnostics-evidence.json).
- TTFT02 real desktop E2E **6/6**: queue promotion and return from background, cancel, first output after 503
  retry, 400 failure, guide isolation, second confirmation and send-now; a real 300 ms Hook attribution;
  about 409.6 ms user wait from first submit to confirmation end; the root requestId is the successful attempt.
- Final OTLP: 6 successful roots, 6 total Histogram samples, 36 main-stage samples, 8 physical-attempt
  observations before first output; 532 unique Span identities; max alignment error **3.379 ms**; all roots
  quality complete; no message, workspace, user or request correlation ID in metric labels.
- 01 compatibility regression, real desktop 3/3. Both suites stay in manual-review/pending.
- CLI affected scope: 122 passed, 1 failed: `v4-gateway.test.ts` “Core admission ACK does not wait for
  TurnStarted projection; old revision retry/file rewind only stale” (expected `stale/proto.staleRevision`, got
  `failed/fault.command.executionFailed`). Reproduced identically at the starting `a77a09bb3e` by loading
  the old sources in isolation; CLI is not claimed green and that test was not changed.
- Controlled macOS process integration: SIGSTOP about 5.2 s then SIGCONT yields clockInvalid; after SIGKILL no
  terminal is fabricated. Low-level tests cover bounded preparation truncation, duplicate/reordered delivery,
  parallel interval union, clock drift and observation expiry marking only unclosed. This is controlled
  testing, not real sleep or desktop crash recovery.
- Controlled exporter tests: a Trace receiver silent for 5 s triggers the 3 s timeout; 100 synchronous
  enqueues do not wait for the network; full-queue/timeout drops are queryable; preparation checkpoints are
  visible before the root ends; duplicate roots/stages add no samples.
- Root typecheck, Desktop E2E typecheck, Bootstrap tsc, lint, architecture gate and this case's fixture check
  pass (pre-existing lint warnings listed separately; no new architecture violation).

### Real-run evidence and rollout conditions

Evidence run `desktop-e2e-20260914084007773-p85037-a1acc63987c6fc6e`: 6 successful TTFTs of about 1.7-14.9 s
including deliberate synthetic model and background/queue wait (not production latency). Renderer long tasks:
5 totaling 513 ms; Electron Browser CPU max about 0.99%, working set max 193344 KiB, Tab max about 4.05% /
302128 KiB; Chromium quantized JS heap about 97.4 MB. No on/off A/B was run, so these are not net telemetry
overhead or a no-leak proof.

At that time ARMS had no samples for the new service and no production OTLP write target or management
permission (capacity/cost/retention) was available; the gray switch stays default off and the user scope is
not widened. Windows/Linux real machines and the full mobile remote-control E2E remain to-do.

### Platform acceptance (2026-09-15)

This supersedes the "no samples" statement above. With ingestion values from CI variables
`ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT` / `_HEADERS`, the diagnostics case (`conversation-session-ttft-diagnostics`,
6/6) plus 01's stages case wrote 12 sends to the Beijing ARMS project, all queryable.

- Diagnostic definitions work: `records` by kind (start 16 / first_output 12 / first_text 12 / excluded 4 /
  checkpoint 442); `excluded` splits cancelled 2 / failed 1 / guided 1; `attempt` splits by role+outcome
  (response/failed 2, response/first_output 12) so main TTFT is not inflated by retries; `no_output.wait`
  records cancelled 2 / failed 1.
- Preparation and wait intervals have samples and P95: context, hooks, persistence, mcp, tools,
  request_assembly, user_confirmation, retry_wait.
- The default experience filter (`quality="complete",visibility="foreground"`) returns idle 4 and queued 1; the
  `quality x visibility` distribution shows foreground 5 / background_returned 6 / background 1, so background
  samples do not leak into the default view.
- Labels are low-cardinality; no correlation ID in metric labels; no `dropped` series observed.
- Still open: console-UI waterfall visual confirmation, packaged-build compile-time injection write path,
  capacity/cost/retention check, Windows/Linux real machines, wider gray rollout. The gray switch stays off.

Details: [rollout checklist](../../monitoring/local-ttft-rollout-checklist.md) and
[platform evidence](../../monitoring/local-ttft-platform-evidence.json).

### Review outcomes and pitfalls

- Standards: a CLI file over 400 lines and a risk of scanning publisher rows with no TTFT were fixed by
  splitting compaction facts, clock sampling and Span/stage projection, and checking for an observation of
  the session before reading the full snapshot.
- Spec: an explicit CLI exit not closed per workspace, and missing quality frozen at first output blocking late
  stage statistics, were fixed (red-to-green and transport-integration regressions). Also: latest-revision
  requestId update, draft first-session binding isolation, and an interrupt after first reasoning closing only
  text observation. Root result and start are neither reversed nor duplicated.
- Pitfalls: preparation checkpoints binding the session early made a normal initial snapshot look like
  recovery (the protocol now distinguishes initial from recovery); wdio-electron-service strips the first
  callback parameter, so Electron callbacks must read `electron` inside the function body; an unconsumed PAUSE
  fixture grabbed a later merged CONFIRM user content (fixed case-locally, with a separate common fixture for
  background title generation). Business send logic was not changed to suit the replay.

Architecture: changed modules `ui / shared / services / desktop / zcode-cli`; the Renderer solely owns
click/visibility/content endpoint, the CLI recorder solely owns execution facts, Main only does bounded export;
no new owner or accepted queue. Pre-commit architecture check baseline=0, new=0.
