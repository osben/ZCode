# Desktop performance profiling plan (orchestrator brief)

Audience: an orchestrator agent that splits this into sub-tasks, runs the measurements and returns a ranked list of bottlenecks backed by evidence. Each sub-agent sees only its own brief, so every workstream below is self-contained.

Goal: **measure first, then explain.** This plan does not change product code. Fixes come later, each with its own spec (`AGENTS.md`).

---

## 0. Ground rules (apply to every sub-agent)

1. **Read-only toward product code.** Do not edit anything under `packages/` or `apps/`. The only allowed writes are:
   - throwaway scripts and outputs under `$PERF_OUT` (outside the repo, see §1);
   - Workstream W7 (benchmark harness), which runs only after the investigation and in its own worktree, with a spec first.
2. **Never touch the real user data.** `~/.zcode/v2` and `~/.zcode/cli` are shared with the upstream app (see `AGENTS.md`, "Shared Databases"). Every run uses an isolated base dir (§1.3).
3. **Use the right build for the right number.**
   - **Timings and CPU %** come from a production-mode build: the E2E staged build, or the packaged `ZCode Preview.app`. Vite dev builds forward every renderer `info/warn/error` log line to main over IPC (`packages/ui/src/logger.ts:13-49`), so they inflate main and renderer cost.
   - **Attribution** (which function is hot) may use the dev build, which has sourcemaps and unminified names. Name the build next to every number.
4. **Repeat and report the spread.** Run every timed scenario at least 5 times. Report median and p90 (p95 when N ≥ 20). Discard the first warm-up run and say so.
5. **Machine conditions are part of the result.** On AC power; Low Power Mode off; no other heavy apps; same display (refresh rate matters for frame metrics). Record CPU model, RAM, macOS version, app commit (`git rev-parse HEAD`) and the build type in `$PERF_OUT/env.json`.
6. **Evidence or it did not happen.** Every claimed bottleneck links to an artifact (`.cpuprofile`, trace `.json`, heap snapshot, ndjson sample file or log excerpt) plus the exact command that produced it.
7. **Separate confirmed from suspected.** A hypothesis from reading code (§6) stays "suspected" until a profile shows it. Remove a hypothesis if the profile shows it is cold.

---

## 1. Setup

### 1.1 Baseline

```bash
node scripts/check-workspace-freshness.mjs
```

```bash
pnpm install
```

- Use the Node version from `mise.toml`.
- Pick the output folder `PERF_OUT=~/zcode-perf/$(date +%Y%m%d-%H%M)` and create it. Never put artifacts in the repo. `pnpm install` is the only permitted write to the checkout (it touches `node_modules` and the pnpm store); everything else goes under `$PERF_OUT`.

### 1.2 Telemetry toggle

`resourceTelemetryEnabled` is a fork setting and is off by default (`specs/resource-telemetry-toggle.md`). The setting and its spec come with PR #157; measure on a build that includes it. **Turn it on for measurement runs.** It brings back the 10 s main-process sampling and the `[memory] role=main` log line every ~60 s. Fork builds have no ARMS endpoint, so nothing leaves the machine.

- In the app: Settings → General → "Resource telemetry".
- In an isolated home (§1.3), before launch: write `{"resourceTelemetryEnabled": true}` into `<home>/.zcode/v2/fork-settings.json`. Settings follow the home dir, not `ZCODE_DATA_BASE_DIR` (`packages/services/src/setting/settingsPaths.ts`).

Run one control pass of the idle scenario (S5) with it **off** as well, to measure the sampler's own cost.

### 1.3 Isolated data

- **Primary isolation is the home dir.** Launch with `HOME=<dir> ZCODE_DESKTOP_HOME_DIR=<dir>`. `setting.json` and `fork-settings.json` resolve from `ZCODE_DESKTOP_HOME_DIR` → `HOME` (`packages/services/src/setting/settingsPaths.ts`). App data defaults to `HOME` (`packages/services/src/paths.ts:14-15`), and this is also how E2E isolates (`.e2e-home`).
- Also set `ZCODE_DESKTOP_USER_DATA_DIR=<dir>/userData` so Electron's userData (cookies, local storage) is isolated too (`desktopRuntimeEnv.ts:67-85`).
- `ZCODE_DATA_BASE_DIR` alone is **not** enough: it moves app data and the CLI dir but not the settings files. Toggling a setting in the UI would then write the user's real `~/.zcode/v2/fork-settings.json`.
- **Verify before the first run:** after launch, `lsof -p <pids> | grep .zcode` lists only paths under `<dir>`.
- Two data sets:
  - `empty`: a fresh base dir.
  - `heavy`: a copy of a real profile with long sessions (≥ 300 turns, many tool calls). Make the copy once and keep it outside the repo. Never upload it, never paste its content into reports. Report sizes and counts only.

### 1.4 Debug ports and process flags (verified in code)

| Process                | How to profile                                                                                                                                                                                                                                                                                                                                                      | Source                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Main (dev, unpackaged) | Chromium remote debugging is already on **port 9229**. To use 9229 for Node `--inspect` instead, disable it with `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1`.                                                                                                                                                                                                     | `packages/desktop/src/main/index.ts:290-292`                                     |
| Main (any build)       | Launch the binary directly: `"/Applications/ZCode Preview.app/Contents/MacOS/ZCode Preview" --inspect=9230 --remote-debugging-port=9222`. macOS has no fuses that block this; only win32 disables Node CLI inspect.                                                                                                                                                 | `electron-builder.config.js:607-610`                                             |
| Renderer               | Help → Toggle DevTools (always present), or attach over CDP on the remote-debugging port.                                                                                                                                                                                                                                                                           | `desktopApplicationMenu.ts:341-346`                                              |
| Host (utilityProcess)  | `ZCODE_DEBUG=<port>` in main's env → `--inspect-brk=<port>`. **Host blocks at startup until a debugger attaches.**                                                                                                                                                                                                                                                  | `desktopHostProcess.ts:276-279`                                                  |
| Agent CLI              | `ZCODE_AGENT_SERVER_COMMAND=node`, `ZCODE_AGENT_SERVER_ARGS_JSON='["--cpu-prof","--cpu-prof-dir=<PERF_OUT>/cli-prof","<repo>/apps/zcode-cli/packages/cli/dist/zcode.cjs","app-server","--stdio"]'`. `--surface desktop` is appended automatically. `NODE_OPTIONS` also reaches the agent (it is not in the sanitize denylist), but the explicit command is cleaner. | `zcodeAgentProcessManager.ts:442-456`, `packages/shared/src/runtimeEnv.ts:43-97` |
| Dev launch             | `pnpm dev:desktop` spawns Electron with fixed args `["."]` (`packages/desktop/scripts/dev.mjs:136-142`). Pass flags through env only (`NODE_OPTIONS`, `ELECTRON_ENABLE_LOGGING=1`), or launch the built app directly.                                                                                                                                               |                                                                                  |

---

## 2. Scenarios and metrics

Each scenario has an ID, a metric definition and a **provisional budget**. Budgets are starting points: the first baseline run replaces them with real numbers, and the orchestrator flags anything more than 20% over budget.

| ID  | Scenario                                                                                                       | Primary metrics                                                                                                                                                                       | Provisional budget                                  |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| S1  | **Cold start** (app not running, `heavy` data)                                                                 | T0 → first window paint → composer interactive. Existing marks: `desktopLaunchMarks.ts:3-15`, `packages/ui/src/lib/launchToInputReport.ts:12`. Main CPU time before first paint.      | Composer interactive < 2.5 s p50                    |
| S2  | **Long streaming answer** (≥ 4k tokens of markdown with code blocks, deterministic replay)                     | Renderer long tasks (count, total ms, max), LoAF if available, dropped frames during the stream, input latency (keypress in composer → paint) mid-stream, main CPU %, renderer CPU %. | No long task > 100 ms; input latency p95 < 50 ms    |
| S3  | **Open a heavy session** (≥ 300 turns) from the sidebar                                                        | Click → first rows painted → scroll-ready. `rendererSnapshotApplyMs` (`conversationProjectionStore.ts:670-685`). Renderer heap delta.                                                 | First rows < 500 ms                                 |
| S4  | **Switch between 5 open tasks** in a loop (20 switches)                                                        | Per-switch latency, long tasks, heap growth across the loop.                                                                                                                          | Switch < 150 ms p95; heap growth flat after warm-up |
| S5  | **Idle**: app open, focused, no activity, 10 min. Then 10 min hidden/minimized.                                | CPU % per process (main, renderer, GPU, host, agent), wakeups. Run with telemetry toggle on and off.                                                                                  | Foreground idle < 1% total CPU; background ≈ 0      |
| S6  | **Long run memory**: 60 min of repeated S2 + S4 cycles                                                         | RSS and JS heap per process over time (slope), detached DOM nodes, listener counts.                                                                                                   | No monotonic growth after the first 10 min          |
| S7  | **Tool-heavy turn**: a turn with many tool calls and large outputs (bash with ~1 MB output, file reads, diffs) | End-to-end turn time, renderer long tasks while tool output streams, host/agent CPU, stdio bytes/s.                                                                                   | No long task > 100 ms                               |
| S8  | **Multi-window**: 3 windows, one streaming                                                                     | Same as S2, measured in the _non-streaming_ windows too (cross-window cost).                                                                                                          | Idle windows stay < 1% CPU                          |

Deterministic input for S2/S3/S7: E2E replays recorded SSE timelines with their original `offsetMs` gaps (`packages/desktop/test/e2e/helpers/upstream-replay-server.ts:830-843`). The fixtures are in `packages/desktop/test/e2e/fixtures/upstream/` and `fixtures/cases/conversation-session/` (`timingPolicy: controlled-stream`). Prefer them over live model calls: they make runs comparable. If no fixture is long enough for S2, record one once (live) and reuse it.

---

## 3. Toolbox (what each tool answers)

1. **Renderer CPU and frames**: DevTools Performance panel. Record with "Screenshots" and "Web Vitals" on and CPU throttling 4× for one run (it exposes long tasks hidden by a fast Mac). Export the trace `.json`.
2. **React render cost**: React DevTools Profiler, "Record why each component rendered". Look for commits per second during streaming and components re-rendering for every frame. React DevTools needs the dev build. Electron does not load extensions by default, so if it cannot be attached, use the Performance panel's component-level "Timings" track instead.
3. **Whole-app timeline (all processes)**: a Chromium trace over CDP, which needs no product code. Connect to the browser endpoint (`http://127.0.0.1:<remote-debugging-port>/json/version` → `webSocketDebuggerUrl`) and call `Tracing.start`. Use categories `devtools.timeline,v8.execute,blink.user_timing,toplevel,disabled-by-default-devtools.timeline.frame,ipc,mojom,gpu` and `transferMode: ReturnAsStream`, then `Tracing.end`. Save the result and open it in https://ui.perfetto.dev. Keep the helper script in `$PERF_OUT/scripts/`. This is the main tool for cross-process questions (IPC, GPU, compositor).
4. **Main process CPU**: `--inspect` → `chrome://inspect` → Profiler, or `--cpu-prof --cpu-prof-dir=$PERF_OUT/main-prof` on the binary.
5. **Host and agent CPU**: `.cpuprofile` via §1.4. Open in DevTools or speedscope (https://www.speedscope.app). Use "left heavy" to find aggregate hot paths.
6. **Memory**: three heap snapshots per process (baseline → after N cycles → after forced GC), using the "Comparison" view. Renderer: DevTools Memory. Main/host: `--inspect`. Count detached DOM nodes and growing `Map`/listener arrays.
7. **Process sampling**: the Resource Manager (Help → Resource Manager) shows live per-process CPU/RSS. For files, E2E already writes `getAppMetrics()` every 3 s to `.e2e-artifacts/<runId>/perf/process-samples-*.ndjson` (`test/e2e/reporting/e2e-reporting.ts:225-260`); the interval is `ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS`.
8. **Agent protocol traffic**: the stdio tap (dev only). Help → "Capture agent stdio traffic" writes ndjson with timestamps and byte counts per frame to `~/.zcode/v2/dev/stdio-traffic/` (`scripts/dev/zcode-stdio-tap.mjs`). Use it to compute frames/s and bytes/s in S2/S7.
9. **TTFT stage breakdown**: run `node packages/desktop/scripts/ttft-otlp-receiver.mjs` (127.0.0.1:14318). Launch with `ZCODE_LOCAL_TTFT_ENABLED=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318`, then read `GET /records`. It gives the stages `renderer_prepare → command_admission → execution_wait → request_prepare → model_request → output_return` (`packages/shared/src/localTtft.ts`). Recipe: `docs/monitoring/local-ttft-queries.md`.
10. **Native/OS view (macOS)**: Instruments → Time Profiler (all ZCode processes), Allocations, and Energy Log for S5. Use it only when JS profiles do not explain the CPU (GPU, native modules, `node-pty`).
11. **Logs**: main log `~/.zcode/v2/logs/YYYY-MM-DD.log` (under the isolated base dir), CLI log `~/.zcode/cli/log/zcode-*.jsonl`. `[memory]` line format: `packages/shared/src/memoryDiagnostics.ts:142-157`.

Existing perf work to reuse, not redo: `docs/performance/` (notably `runtime-communication-repro.md`, which has a CPU-profiling E2E with `ZCODE_E2E_PROFILE_STREAMING=1` and a baseline) and `conversation-session-ttft-diagnostics.test.ts` (long-task count, heap and app metrics per test).

---

## 4. Workstreams (one sub-agent each)

**Shared rules for every workstream:**

- Each workstream writes only to `$PERF_OUT/<workstream-id>/`.
- Each workstream ends with `$PERF_OUT/<workstream-id>/findings.md` in the format in §5.
- No two workstreams share an output folder or edit the same file.
- W1–W6 are read-only and can run in parallel, **except that runs which measure CPU must not overlap in time on the same machine.** The orchestrator serializes the timed runs and lets analysis overlap.

### W1: Renderer (S2, S3, S4, S8)

- Brief: Profile the renderer in S2, S3, S4 and S8 on the production-mode build, using the Performance panel trace plus React Profiler on the dev build for attribution.
- Answer these:
  - Frame budget during streaming.
  - Commits per second.
  - Top 10 self-time functions.
  - Whether `ConversationProjectionStore` notifications (`packages/ui/src/v4/conversationProjectionStore.ts:361-363`: synchronous, no rAF batching) line up with long tasks.
  - The cost of Streamdown with `parseIncompleteMarkdown` while streaming (`components/ai-elements/message.tsx:694-700, 1627-1642`).
  - Shiki highlighting cost (`lib/shikiHighlighter.ts`).
  - Scroll anchoring and auto-follow (`v4/ConversationTimeline.tsx:1665-1707`, `reasoning.tsx`).
  - Virtualization effectiveness in S3 (row count mounted versus visible).
- Done: the metrics for S2/S3/S4/S8 per §2, 5 runs per scenario (§0), and a ranked hot-path list.

### W2: Main process (S1, S2, S5, S7)

- Brief: CPU-profile main with `--cpu-prof` or `--inspect` in S1, S2, S5 and S7.
- Answer these:
  - How much main time goes to synchronous fs. Prime suspect: `packages/desktop/src/main/logger.ts:80,88` runs `mkdirSync` + `appendFileSync` **for every log line**, including host-relayed and renderer-forwarded lines. Count log lines/s in each scenario and correlate with the profile.
  - Whether host-log relay volume (`hostLogRelay.ts`) scales with streaming.
  - Whether the resource sampler shows up (toggle on vs off in S5).
  - Startup sync work (`desktopRuntimeEnv.ts`, `desktopCrashCapture.ts`, `editors.ts`).
- Main should hold no business state (`AGENTS.md`). Flag any business work you find in main.
- Done: main CPU % per scenario, top self-time functions, log lines/s, and a list of event-loop stalls > 50 ms with stacks.

### W3: Host and agent CLI (S2, S7)

- Brief: CPU-profile the host (`ZCODE_DEBUG`, attach and profile) and the agent (`ZCODE_AGENT_SERVER_COMMAND` with `--cpu-prof`) in S2 and S7. Capture the stdio tap in the same runs.
- Answer these:
  - Frames/s and bytes/s on stdio.
  - Serialization cost: earlier hotspot `packages/rpc/src/serialization.ts` (`docs/performance/runtime-communication-repro.md:75-91`).
  - Topic publisher coalescing. The flush window is 30 ms on desktop and 150 ms replayable (`packages/shared/src/zcode-protocol-v4/core.ts:34-59`). Check whether the effective rate matches.
  - JSON parse/validate cost per frame (zod runtime validation on hot paths).
  - Tool output handling for large outputs.
  - TTFT stage breakdown via the OTLP receiver.
- Done: CPU profiles for host and agent, a per-stage TTFT table, and a frame-rate/size histogram.

### W4: Cross-process timeline (S2, S7)

- Brief: Capture full Chromium traces over CDP (§3 item 3) for S2 and S7. Correlate:
  - the agent emitting a frame (stdio tap `ts`);
  - the renderer receiving and committing it (trace);
  - the next paint.
- Measure end-to-end chunk latency (emit → paint) and where it accumulates (host, MessagePort, renderer queue, React commit, paint).
- Topic frames go host → renderer over a direct `MessageChannelMain` port, not through main (`desktopHostProcess.ts:810-822`). Confirm this in the trace.
- Done: a latency waterfall for ≥ 50 chunks (p50/p95 per hop) and the Perfetto traces.

### W5: Memory and leaks (S4, S6)

- Brief: Run S6 for 60 min with `[memory]` lines enabled (toggle on). Take heap snapshots at 0, 10, 30 and 60 min for the renderer, main and host.
- Answer these:
  - RSS and heap slope per process.
  - Retained objects that grow (comparison view).
  - Detached DOM.
  - Subscriptions and listeners not released on task switch or session close.
  - Caches without bounds.
- Done: a slope table, the top 5 growing retainers with retainer paths, and the snapshots.

### W6: Startup (S1)

- Brief: Measure cold start 10× on the packaged Preview app with `heavy` data. Capture:
  - a main `--cpu-prof` from launch;
  - a Chromium trace from launch (`--trace-startup --trace-startup-file=$PERF_OUT/w6/startup.json` on the binary);
  - the existing launch marks.
- Break down: process launch → main ready → window created → renderer first paint → data hydrated → composer interactive. List work on the critical path that could be deferred (module eval size, sync fs, settings/DB reads, ARMS init await at `index.ts` even with ARMS disabled, MCP and plugin startup).
- Done: a phase waterfall (p50/p90) and the top 10 critical-path items with cost.

### W7: Repeatable benchmark (after W1–W6, writes code)

- Runs only after the findings are in, in its own worktree.
- Spec first: `specs/performance-benchmark.md`.
- Build a wdio-based benchmark spec that replays the S2/S3/S4 fixtures and collects metrics into JSON:
  - long tasks via a `PerformanceObserver` injected by the test;
  - `getAppMetrics`;
  - `performance.memory`;
  - the existing launch marks.
- Run it N times and compare against a stored baseline. Reuse `conversation-session-ttft-diagnostics.test.ts` and `runtime-communication-performance.test.ts` patterns.
- Single-spec run: `ZCODE_E2E_SPEC=<path>`. Manual-review specs need `ZCODE_E2E_MANUAL_REVIEW=1`. `ZCODE_E2E_SKIP_BUILD=1` reuses the build.
- Done: one command produces a metrics JSON, plus a comparison script that fails on a > 20% regression.

---

## 5. Findings format (every workstream, and the final report)

```markdown
## <short title>

- Scenario / build / runs: S2 / e2e-staged prod / 7 runs (first discarded)
- Impact: <metric> = <median> (p90 <x>) vs budget <y>
- Where: <process> → <file:line or function> (self <ms>, total <ms>, % of scenario)
- Evidence: <artifact path(s)> + command used
- Confidence: confirmed (profile) | suspected (code reading, not yet profiled)
- Why it is slow: <mechanism, one or two sentences>
- Candidate fix direction: <one line; no code>
```

The **final report** (orchestrator, `$PERF_OUT/REPORT.md`) contains:

1. The environment (`env.json`) and builds used.
2. A scenario table with the measured baseline for each S1–S8 versus budget.
3. The **top 10 bottlenecks**, ranked by user-visible impact. Impact means time on the critical path, or frame drops, times frequency. Raw CPU share alone does not rank.
4. A "suspected but cold" list: hypotheses from §6 the profiles ruled out.
5. Proposed next steps, each sized S/M/L and naming the spec it needs. The orchestrator does not start them.

---

## 6. Leads from code reading (verify, do not assume)

| #   | Suspect                                                                                               | Where                                                                                 | Check in |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| L1  | Projection store notifies all listeners synchronously per frame, with no rAF batching                 | `packages/ui/src/v4/conversationProjectionStore.ts:361-363`                           | W1, W4   |
| L2  | Streamdown re-parses incomplete markdown on every delta of a long message                             | `components/ai-elements/message.tsx:694-700`                                          | W1       |
| L3  | Main logger runs `mkdirSync` + `appendFileSync` per line, and dev renderer logs are forwarded to main | `packages/desktop/src/main/logger.ts:80,88`, `packages/ui/src/logger.ts`              | W2       |
| L4  | RPC serialization on the host/renderer path                                                           | `packages/rpc/src/serialization.ts`                                                   | W3       |
| L5  | Scroll anchoring and reasoning auto-follow cause layout thrash during streaming                       | `v4/ConversationTimeline.tsx:1665-1707`, `reasoning.tsx`                              | W1       |
| L6  | Runtime zod validation of every protocol frame                                                        | `packages/shared/src/zcode-protocol/index.ts`                                         | W3       |
| L7  | Startup awaits ARMS init and other sync work even when ARMS is disabled                               | `packages/desktop/src/main/index.ts` (`await armsInitPromise`), `appARMSBootstrap.ts` | W6       |
| L8  | Idle wakeups from timers (resource sampler, heap diagnostics, rollout refresh every 60 s)             | `desktopResourceTelemetry.ts`, `rendererActionTraceIpc.ts`, `memoryDiagnostics.ts`    | W2 (S5)  |

---

## 7. Orchestration order

1. Setup (§1), once. Record `env.json`.
2. Baseline timed runs, serialized: S1 → S5 → S2 → S3 → S4 → S7 → S8, with the toolbox items W1–W6 need attached to the same runs where possible (one run can feed a renderer trace and a main CPU profile at once).
3. W1–W6 analysis in parallel on the collected artifacts. Re-run only what a workstream needs.
4. S6 (60 min) in the background, on a machine slot with no other timed runs.
5. Synthesis → `REPORT.md`.
6. Stop. Present the report to the user. W7 and any fix start only on the user's go-ahead.
