# ZCode CLI Compact Implementation Plan v2

## Document positioning

Implementation plan for `docs/design/v2/compact/README.md`. Compact semantics are owned by the
README; implementation shape follows ZCode's layering, event store and cross-platform
constraints. Related: `compact-phase-memory-plan.md`.

The goal was to make compact an observable boundary in the session state machine — trigger,
events, summary, post-compact context, failure and recovery paths — before any "big summary
function".

## Fixed order

The first version uses one fixed post-compact order:

```text
compact boundary
compact summary
messages to keep
attachments
hook results
```

This order is the most important invariant. Resume, rewind, SDK stream, TUI projection and the
provider context builder all understand compact through it.

## Fixed thresholds

First-version defaults, to be tuned against real token statistics:

| Name | Initial value | Purpose |
| --- | ---: | --- |
| summary output reserve | `min(modelMaxOutputTokens, 32_000)` | Reserve space for summary output and later requests; default 32k when the model has no output cap. |
| auto compact buffer | `13_000` | Auto compact does not wait for a full window. |
| warning/error buffer | `20_000` | UI/SDK context warning. |
| manual compact buffer | `3_000` | Blocking protection when auto compact is off. |
| max auto failures | `3` | Auto compact failure circuit breaker. |
| prompt-too-long retries | `3` | Drop oldest API rounds and retry when the compact request itself is over-window. |
| streaming summary retries | `2` | Retry when a streaming summary request yields no valid text. |

These thresholds declare no environment-variable entry. Debug and operations overrides go through
config files, CLI/session overrides or test injection, so temporary tuning does not ossify into a
long-term environment-variable contract.

## Fixed boundary policy

The only trusted marker of a successful compact is a written boundary, not "a summary string was
obtained". The boundary contains:

- trigger: `manual`, `auto`, `partial`, `reactive`, `session_memory`
- pre-compact token estimate
- last summarized message id
- summarized message count
- preserved segment metadata
- compacted tool/schema state
- traceId, sessionId, turnId, spanId

If the boundary or a preserved-segment relink is corrupted, recovery conservatively loads the
full history and warns; it never silently drops history.

## Layer mapping

| Responsibility | ZCode location | Notes |
| --- | --- | --- |
| `/compact` entry | `packages/cli` / `packages/tui` | `/compact [instructions]`; parses user intent only. |
| compact state machine | `packages/core/src/compact` | State machine and business orchestration. |
| auto compact trigger | `packages/core/src/context` + `packages/core/src/compact` | Context budget policy and auto trigger. |
| summary prompt | `packages/core/src/compact` | Prompt template; provider calls still go through the adapter. |
| microcompact | `packages/core/src/context` + `packages/adapters` | Tool result budget does local replacement first; provider cache edit is deferred. |
| session memory compact | `packages/core/src/memory` + `packages/core/src/compact` | Session memory is only a summary source; it never bypasses the boundary. |
| active chain and boundary lookup | `packages/contracts` + `packages/core/src/agent/message-history.ts` | Active chain, boundary lookup, post-compact chain construction. |
| session storage | `packages/adapters/src/storage` | Append-only message/part storage and resume/relink. |

Core never reads/writes files directly, reads `process.env`, or calls provider SDKs directly; all
external I/O is injected through contracts.

## Milestones

### M0: Contracts

`CompactBoundary` and `CompactSummary` runtime schemas; `CompactTrigger`, `CompactStatus`,
`CompactFailureReason` stable enums; compact payload for session events/parts; pure functions
`buildPostCompactMessages(result)`, `getMessagesAfterCompactBoundary(messages)`,
`annotateBoundaryWithPreservedSegment(boundary, segment)`.

Tests: the post-boundary active chain contains only summary, preserved messages, attachments and
hook results; multiple boundaries resolve to the latest; a missing/corrupted preserved segment
returns the conservative fallback with a structured warning; the schema rejects unknown
triggers, missing traceId and missing summarized anchors. No provider, no CLI; unit tests prove
the boundary already drives session projection.

### M1: Manual `/compact` MVP

The first manual compact cut promises full compact only, no partial keep segments. The
persistence boundary is protected: the summary message, its text part and the compaction part
are one logical write unit — if the compaction-part write fails, the already-written summary
message is deleted so resume never treats a half summary as real history. The boundary records
`lastSummarizedMessageId` and writes the same value into the compaction part's `tail_start_id`,
anchoring later rewind, partial compact and preserved-segment relink.

Flow: CLI/TUI parses `/compact [instructions]`; core takes active messages after the latest
boundary; too few messages returns `Not enough messages to compact.`; `PreCompact` hook merges
user and hook instructions (user first); a no-tools summary prompt goes through the provider
adapter in one round; `<analysis>` is stripped, keeping only `<summary>`; boundary and compact
summary are created; post-compact attachments are appended; the session log/message part is
written; `PostCompact` runs; TUI/SDK receive `compact.completed` and `compact_boundary`.

First-version post-compact attachments:

- recently read files: at most 5, total budget 50k tokens, at most 5k tokens per file;
- current plan/todo state;
- invoked-skill summaries: 5k tokens per skill, 25k total;
- deltas of deferred tools / MCP instructions / agent listings;
- session-start hook results.

Tests: a custom `/compact 重点保留测试输出` reaches the summary prompt; hook instructions are
appended after user instructions; a summary-agent tool call is rejected and converts to failure
or retry; the next context builder after compact contains no old history; a failed compact
writes no half boundary. Acceptance: both non-interactive `--prompt` and TUI trigger manual
compact; the transcript still shows old history while the provider active context sees only the
post-boundary projection.

### M2: Auto compact

Policy and circuit breaking live in core runtime and never read environment variables;
CLI/bootstrap resolves `ZCODE_` environment variables and user config into
`AgentRuntimeConfig.compact`. An auto compact failure must not fail the current user turn; it
only increments the consecutive-failure counter, and after `maxConsecutiveFailures` further
automatic attempts are skipped until one successful compact resets the counter.

```text
effectiveWindow = contextWindowForModel - min(modelMaxOutputTokens, 32_000)
autoThreshold = effectiveWindow - 13_000
shouldCompact = activeTokenEstimate >= autoThreshold
```

Skip conditions: user config disables compact; user config disables auto compact; `querySource`
is `compact`, `session_memory`, the summary agent, or a subagent internal compaction path; the
session's consecutive auto-failure count has reached 3.

Tests: over-threshold triggers; under-threshold does not; a compact's own request never
recursively auto-compacts; after 3 failures the breaker trips and later turns stop burning the
provider; success resets the counter. Acceptance: `compact.started`, `compact.completed` and
`compact.failed` all carry pre/post tokens, threshold and `willRetriggerNextTurn`; on auto
compact failure the current turn continues with the original messages unless the provider really
returns context overflow later.

### M3: Prompt-too-long and overflow fallback

The main session never trims its own history. It only detects provider context overflow, hands
recovery to compact, and retries the current model step after compact succeeds. All active
context trimming, summary generation, boundary persistence and resume/replay semantics stay in
the compact module — the main session and compact never each keep their own discard policy.

First case — the compact request itself is prompt-too-long; retry after head truncation:

- Group messages by API round, oldest to newest.
- Drop oldest groups according to the provider-reported token gap.
- If the token gap is unparseable, drop the oldest 20% of groups.
- Never let the remaining messages start with an assistant message; insert a meta user marker if
  needed.
- Retry at most 3 times; after the 3rd failure compact returns the non-auto-retryable
  `model_context_exceeded`, which the auto compact outer retry must not amplify into 3x3.
- The current implementation covers the text-message path: when the compact summary provider
  call throws or returns prompt-too-long text, the runtime drops the oldest round, rebuilds the
  compact request, and appends a separate `model_request` event per attempt.
- Truncation affects only the input the summary model sees; a successful compact still creates
  the standard full compact boundary and replaces the active context with the summary message.
- If still PTL after 3 attempts, manual compact surfaces `model_context_exceeded`; auto/reactive
  compact keeps its existing failure-degradation handling.

Second case — the main request is already prompt-too-long:

- Overflow detection only; no message deletion inside the main session.
- Reactive compact runs: `CompactTrigger.Reactive`, `CompactReason.ProviderOverflow`.
- After reactive compact succeeds, the current provider request replays.
- Only if it still fails does the context overflow surface as a user-visible error.
- The reactive retry guard is scoped to the current model-step retry chain: after a successful
  reactive compact the guard stays used, and an in-place retry that still overflows throws
  `model_context_exceeded` directly, preventing infinite retries. Only after the full sibling
  tool-result batch of the same product turn is all terminal, persisted and guide-drained does
  the next model step open one new reactive compact.
- No-tool stream recovery, Start Plan admission retry, Stop hook continuation, compact
  skipped/failed, and partial or aborted tool batches never reset the guard.
- Only a successful compact that actually wrote a boundary updates the fast-backfill tracker; a
  healthy no-op `skipped` neither resets `toolTurnsSinceCompact` nor counts toward consecutive
  fast backfill.
- Auto/reactive compact share the current product turn's fast-backfill tracking: after each
  successful compact, complete tool batches count from 0. If the context re-reaches the
  compact/overflow condition within fewer than 3 tool turns 3 times in a row, the 3rd backfill
  trips the breaker — no further compact starts, and an actionable `model_context_exceeded` is
  exposed. Reaching at least 3 tool turns before backfill resets the streak to zero.
- The fast-backfill breaker is independent of the existing consecutive-failure breaker: the
  former lives only in the current product turn; the latter keeps working on session-level
  failure counts.
- Reactive compact reuses the full compact boundary events
  (`CompactBoundary.trigger = reactive`) and still writes the summary message + compaction part,
  so resume, fork and rewind all recover from the same compact boundary.
- Reactive compact respects `compact.enabled === false`; when disabled it exposes the provider
  context overflow directly with no implicit state rewriting.
- If the reactive compact itself fails, the current turn exposes the original context overflow;
  the compact failure only goes to logs and never pollutes the active provider history.

Tests: a compact summary request PTL drops the oldest round and retries; persistent failure gives
the user an actionable error; a main request PTL followed by a successful compact continues the
turn; an in-place reactive retry that overflows again starts no second compact; a later model
step after a complete tool batch that overflows allows a second reactive compact; 3 consecutive
fast backfills trip the breaker while a backfill after 3 tool turns resets the streak; oversized
media/documents are replaced with `[image]`/`[document]` before summarizing. Acceptance: the
user never dead-ends on "the summary request is also too long"; every PTL retry has
trace/span and dropped-message counts.

### M4: Tool result budget and local microcompact

Full compact is not the only pressure valve: trim tool results before summarizing history.

Stage one is provider-neutral local message projection:

- Large tool output goes to artifact/storage.
- The provider context keeps only summary, hash, artifact ref and a truncation note.
- Old tool results already in active history are replaced before each request with a stable
  placeholder, e.g. `[Old tool result content cleared by microcompact]`.
- Original tool parts, transcript, artifacts and checkpoints are not deleted; microcompact is a
  provider-visible projection, not a full compact boundary.
- Read/Bash/Grep/Glob/Edit/Write/WebFetch/WebSearch are covered first; `WebSearch` has a local
  tool result budget, and the sources/content of its internal provider-native `web_search` side
  request fold into the normal tool result.

Landed subset:

- Each tool contract declares `resultBudget`; the tool executor truncates or writes to artifact
  by `maxModelBytes` before the result enters provider-visible context; the `ToolCallResult`
  event carries `truncated`, `originalBytes`, `returnedBytes`, `budgetStrategy` and
  `artifactPath`; the runtime injects the budgeted `modelContent`; the runtime runs the
  provider-neutral local microcompact projection before every model request.
- Local microcompact strategies: `time_based` (in a main/root session, when more than the
  default 60 minutes have passed since the last assistant completion, clear old compactable tool
  results, keeping at least the most recent 1 and by default the most recent 5) and
  `token_pressure` (clear old compactable tool results when active context exceeds the local
  microcompact threshold, which sits below the full auto compact threshold so summaries are not
  triggered prematurely).
- The `microcompact_boundary` event records trigger, strategy, pre/post token estimate,
  `tokensSaved`, `clearedToolCallIds`, `keptToolCallIds`, traceId and turnId.
- After a successful local microcompact, the in-memory `messageHistory`'s provider-visible
  messages are replaced, but the most recent assistant's provider usage baseline is preserved
  (found by reverse scan) as an intentionally accepted approximation. The session store keeps
  original tool parts; after resume the same policy re-projects.

Provider cache edit/reference is deferred: enabled only when the provider adapter declares
support; `microcompact_boundary` (or equivalent) is emitted only after the server-side cache
deletion succeeds; local messages never pretend to be server-side deleted.

Tests: over-budget tool results are not fed back into model context; artifact refs trace to full
output; local microcompact clears old tool results while preserving tool_call/tool_result
pairing; microcompact creates no full compact boundary; unsupported providers degrade to local
projection. Acceptance: large outputs do not push the next turn into auto compact; the UI can
still open full tool output; resume does not depend on the microcompact event to trim history —
the next request re-projects.

### M5: Partial compact and rewind (pending)

Waits for the message selector / rewind foundation. Two directions:

- `from`: summarize messages after the pivot, keeping the earlier context.
- `up_to`: summarize messages before the pivot, keeping the newer context.

Key invariants:

- Never split a tool_use/tool_result pair.
- Never split the thinking/tool blocks of one assistant message id.
- In the `up_to` direction, remove old compact boundaries and summaries from the kept segment so
  backward scans don't hit the old boundary.
- The boundary records preserved-segment relink info.

Tests: stable message order in both directions; a pivot inside a tool pair expands the
keep/summarize ranges; post-partial-compact rewind shows only the legal range; successful relink
keeps the resume active chain consistent; failed relink conservatively loads full history with a
warning. Acceptance: the UI labels pre-compact checkpoint risks; after compact only rewind past
the boundary is promised.

### M6: Session memory compact (pending)

Session memory is an optional acceleration path, not a second compact system.

Trigger conditions: only attempted without user custom summary instructions; waits for in-flight
memory extraction; returns `null` when the session memory file is missing, an empty template, or
`lastSummarizedMessageId` is not found; keeps recent context by default (min 10k tokens, at
least 5 text messages, max 40k tokens); returns `null` and falls back to traditional compact
when still over threshold after compaction.

Tests: with session memory available, the summary provider is not called; when unavailable it
safely falls back; memory compact still produces the same boundary/summary/post-context;
`lastSummarizedMessageId` resets after success. Acceptance: session memory compact and
traditional compact return an identical structure to callers.

### M7: UX, SDK and observability

Events: `compact.started`, `compact.progress`, `compact.boundary.created`,
`compact.summary.created`, `compact.completed`, `compact.failed`.

Persistence trace:

- The compact lifecycle additionally writes one synthetic timeline message. It is neither a
  provider-visible summary nor a tool call; it serves the transcript, TUI, ZCode app-server
  replay and recovery diagnostics.
- The timeline message uses the `compaction` part, but `timelineStatus` says
  `started` / `completed` / `failed` / `interrupted`; only a compaction part with
  `compactBoundary` can act as an active-chain truncation boundary.
- Compact first writes the timeline message + `compact_started` event; after the summary and
  boundary write succeeds, the same timeline message is updated to `completed` and the
  `compact_completed` event is written.
- If the process is interrupted during the summary request, the next `resumeFromStore()` marks a
  timeline part without a terminal state as `interrupted`; if a boundary for the same operation
  already exists, it recovers as `completed`.
- ZCode app-server adds no main-path notification. Bootstrap projects the compact lifecycle into
  `agent_message_chunk + messageId + _meta["zcode.timeline"]`; clients recognizing the meta
  render a separator; generic ZCode protocol clients show fallback text.

Metrics: trigger, querySource, traceId, sessionId, turnId; `preCompactTokenCount`; compaction
input/output/cache tokens; `truePostCompactTokenCount`; `autoCompactThreshold`;
`willRetriggerNextTurn`; summarized/kept/attachment message counts; failure reason, retry count,
circuit-breaker state.

User hints:

- Manual compact success: `Compacted`; verbose mode shows the summary, otherwise only a hint to
  open the full summary.
- Auto compact: TUI spinner/status, SDK `status=compacting`.
- Failure: manual compact surfaces a clear error; auto compact logs silently by default so it
  never interrupts current work.

Tests: the SDK stream receives the compact boundary; the TUI renders it; the non-interactive CLI
transcript writes the compact part; logs never leak the full old transcript — debug mode traces
via artifact refs.

## First-batch scope

Not in the first batch (later work, not to be smuggled in): context collapse; provider
cache-edit microcompact; session memory compact; partial compact; a separate subagent compact
strategy; cross-session long-term memory merging; complex UI message selectors.

The first batch is: contracts, manual full compact, auto compact, PTL retry, the basic tool
result budget, and provider-neutral local microcompact.

## Verification checklist

Every implementation PR runs at least `npm run lint` and `npm test`. Key unit tests must cover:

- the active chain starts after the latest boundary;
- successful compact writes boundary and summary;
- failed compact writes no half state;
- auto compact threshold, disable config, recursion guard, breaker;
- prompt-too-long retry;
- resume after compact does not load trimmed history;
- preserved-segment relink success/failure;
- over-budget tool output never enters model context directly.

## Risks and constraints

- Summary is lossy; the prompt must force-keep explicit user constraints, file paths, error
  fixes, current work and next steps.
- UI scrollback and provider active context stay layered; the user must not believe old history
  is still verbatim visible.
- Compact's provider requests, hooks and session writes all inherit the same traceId.
- Compact never swallows errors at low levels; only auto compact may degrade a failure to
  "continue this turn, record consecutive failure".
- Core never depends directly on the filesystem, provider SDKs, `process.env` or a shell.
- All config and environment variables use the `ZCODE_` prefix.
