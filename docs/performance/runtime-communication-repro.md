# Runtime Communication Performance Reproduction

## Background

The renderer CPU issue under investigation is suspected to occur while a task is actively communicating,
not only when opening a long persisted history. Static database fixtures are useful for cold render and
scroll baselines but do not exercise provider SSE, app-agent protocol fanout, subagent continuation, tool
updates or React updates during an active turn. This suite builds repeatable environments; root-cause
profiling and fixes are a separate phase.

## Communication chain

```text
Provider replay SSE
  -> zcode-cli runtime events
  -> @zcode/protocol stdio NDJSON
  -> host process session services
  -> renderer desktop-continuous subscription
  -> v4 pane projection store
  -> React render / layout / paint
```

All cases use desktop `desktop-continuous` and must not be used to infer mobile `/remote`
`web-remote-replayable` snapshot or gap-recovery behavior.

## Case set

| ID                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Setup                                                                                                   | Action                                                                 | Evidence                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PERF01                      | Isolate one visible pane under high-frequency stream traffic.                                                                                                                                                                                                                                                                                                                                                                                                   | One v4 pane, one session, synthetic recorded-stream fixture with many text/reasoning/tool-input chunks. | Send one prompt and keep the stream open long enough for CPU sampling. | Network artifact with chunk timeline, optional CDP profile, UI remains responsive. |
| PERF02 (retired 2026-10-16) | Reproduced visible four-pane runtime fanout with tools and subagents (four prompts each triggering an `Agent` tool, a streamed child subagent response, then a streamed parent final response, all panes reaching final markers). Retired because the split entry was removed and users can no longer create a four-pane layout; its spec, fixture and the `openV4SplitFromSidebar` helper are deleted. Only the baseline below is kept as historical evidence. | Four v4 panes in one workbench, each bound to a different session.                                      | -                                                                      | -                                                                                  |

## Recording and profiling

Phase 1 records user-visible evidence: WDIO drives the path, the in-app Electron window recorder
captures a video artifact, and the DeepSeek replay server writes request and response chunk timelines.
Recording requires `ffmpeg` on `PATH`, or `ZCODE_E2E_FFMPEG_PATH` pointing at a compatible binary. A run
without video but with a renderer CPU profile sets `ZCODE_E2E_PROFILE_ONLY=1` and
`ZCODE_E2E_PROFILE_STREAMING=1` (with `ZCODE_E2E_MANUAL_REVIEW=1` and
`E2E_PROVIDER_REPLAY_FIXTURE_PATH` for the replay fixtures).

Phase 2 adds profiler evidence once a case reliably reproduces high CPU: start an Electron/Chromium
performance profile during overlapping streams; compare active pane render cost, hidden shell fanout,
protocol event batching and tool/subagent update frequency. High-volume protocol or streaming
diagnostics stay at `debug`; no production `info` logs for per-chunk traces.

## 2026-07-08 local baseline (PERF02 with profile-only, historical)

- Artifact dir: `packages/desktop/.e2e-artifacts/runtime-perf-20260708105637`; case duration `99552ms`.
- Visible renderer tab CPU mean / peak: `2.59%` / `3.87%`; total Electron CPU mean / p95 / peak:
  `4.19%` / `5.96%` / `6.85%`.
- Visible renderer working set: `254MB` at start, `424MB` peak, `391MB` near end.
- Renderer V8 profile duration `97455ms`: about `82318ms` idle, `10320ms` unattributed program time,
  `399ms` GC self time.

Mapped renderer self-time hotspots:

- `packages/ui/src/components/ai-elements/reasoning.tsx`: reasoning content auto-follow scroll and mask
  updates, especially `scrollToReasoningBottom`.
- `packages/ui/src/v4/ConversationTimeline.tsx`: bottom anchoring layout effect and scroll handling
  during streaming height changes.
- React DOM commit/render work triggered by streaming updates.
- `packages/rpc/src/serialization.ts`: small but visible deserialize cost for protocol frames.

The baseline does not show a renderer process pegging CPU under deterministic replay; the bottleneck
shape is repeated streaming-driven React commit/layout work plus renderer memory growth. A follow-up
high-CPU reproduction should either increase chunk concurrency/frequency or run against the live
provider scenario where the original CPU spike was observed.

## Boundaries

- Desktop local `desktop-continuous` only; no direct SQLite fixture injection.
- No separate mobile replayable or remote-host runtime is created.
- The four-pane layout of the historical case used the existing v4 pane split behavior and the
  `MAX_WORKBENCH_PANES = 4` boundary.
- Provider traffic is synthetic replay; the goal is deterministic communication pressure, not live
  model quality.
