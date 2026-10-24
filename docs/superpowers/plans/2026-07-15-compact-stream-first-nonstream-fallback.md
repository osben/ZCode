# Compact Stream-first → Non-stream Fallback

> Implemented (2026-07-15). Design contract:
> [2026-07-15-compact-stream-first-nonstream-fallback-design](../specs/2026-07-15-compact-stream-first-nonstream-fallback-design.md).
> The earlier Responses JSON compatibility plan kept only a superseded note; its normalizer
> is reused as this feature's HTTP fallback leg.

## Transport contract

One logical compact attempt:

```text
streamText(compactRequest)
├─ finish → hidden aggregated summary
├─ request setup 404, or eligible failure before response body commit
│  └─ generateText(same semantic compactRequest)
└─ any other request setup / post-commit failure → rethrown unchanged
```

then the existing summary validation, timeline and persistence.

Frozen unchanged: compact prompt, tools, thinking, selection, preserved tail and boundary;
manual/auto/reactive lifecycle with at most 3 logical auto attempts; adapter SSE/HTTP retry
counts, backoff and idle timeout; normal main-turn streaming, eager tool calls and recovery;
protocol, UI, desktop-continuous, web-remote-replayable; cache-sharing fork, independent
summarizer and fixed compact model.

Key rules delivered:

- The compact request is constructed once; stream and fallback reuse the same semantic
  input (equality by value, not object identity).
- The hidden aggregate commits only text blocks that reached text end, tool calls, usage,
  finish reason and top-level provider metadata; reasoning keeps only delta/commit state. No
  compact `ModelStreaming` is created or persisted. Unclosed trailing blocks after a
  completed block never pollute the summary.
- Commit provenance: message-block providers commit only on raw `content_block_stop`; with
  raw provenance, block start and delta-type matrices are validated per index before commit.
  Without provenance, a normalized block end counts as a completed block — which ends SSE
  retry and forbids HTTP fallback. Empty SSE, missing response start, no block and no stop
  reason must fall back. AI SDK synthetic end/finish never counts as a provider commit.
- Setup vs body: the hard transport status (real response status from the iterator)
  distinguishes request setup from response body and outranks header and logical status.
  Setup keeps the existing adapter/API retry; only a real HTTP 404 after retry exhaustion
  enters the non-stream fallback; synchronous setup errors, deterministic config/model
  errors and other 4xx/5xx rethrow. SSE logical status never impersonates setup status.
  After the first real provider event (excluding `ping`), SSE retry stops and Core decides
  the HTTP fallback; only pre-first-event stale/watchdog retry remains, and caller
  cancellation wins.
- Tool calls in compact publish at input end (not eagerly); a direct provider tool-call
  validation failure first commits what is provable, stops SSE retry, then propagates.
  Invalid raw start/delta/stop throws at the Core observation point; the manual iterator
  aborts every non-natural-EOF physical attempt, best-effort `return()`s, and completes a
  cancelled terminal state when the consumer closes early.
- Abort, context exceeded and media-too-large return to their dedicated recovery paths.
- Fallback logs exactly one low-frequency warn.
- Adapter strategy is the one-way `preserveProviderStreamBoundaries?: boolean` (compact-only
  semantics); normal main requests keep eager tool calls and best-effort flush.

## Acceptance matrix

| Layer    | Must prove                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core     | stream success; empty SSE/orphan/eligible body failure/HTTP 404 setup fallback; other setup, post-commit, abort/context/media do not fall back; hidden stream never lands in session   |
| Adapter  | compact observes raw non-ping events and projects response-start/block-start-stop/stop-reason; hard transport status separates setup/body errors; setup keeps API retry, inner stream only pre-event stale/watchdog retry with cancellation first; direct tool validation commits first; main eager unchanged |
| Responses | `stream:true / failure → non-stream / success`; missing-field JSON still compatible                                                                                                   |
| Desktop  | normal stream compact and fallback compact both reach the success marker; model selection and main requests do not regress                                                              |
| Static   | core/adapters tests, CLI/root typecheck, root lint, fixture/typecheck:e2e, diff check                                                                                                   |

## Open follow-ups

`manual-review/pending` specs still asserting non-stream are not counted toward transport
coverage or promotion until migrated and re-run:

- `conversation-session-compact.test.ts` — not yet migrated.
- `conversation-session-model-switch-auto-compact.test.ts` — migrated to the V4 helper with
  streaming success assertions; N06 healthy no-op passes; N05 confirm/cancel fails before
  the compact request because a guard dialog is missing — kept as a product-semantics
  failing probe (the N05 gap is out of scope for stream-first; do not implement or loosen
  it alongside).
- `conversation-session-model-switch-compact.test.ts` — not yet migrated.
