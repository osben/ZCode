# ZCode CLI Compact Design v2

## Document positioning

This is the v2 compact candidate design, currently `L1 Candidate Contract`: it fixes compact's
domain boundaries, state changes, external contracts and risks, but not final TypeScript
interfaces, database schemas or the full event-field set.

Implementation split: [plan.md](./plan.md). The compact phase semantics and the memory read/write
path incremental plan: [compact-phase-memory-plan.md](./compact-phase-memory-plan.md).

Compact's goal is not to reduce visible UI messages, but to switch the model-visible context from
"full history" to "boundary + summary + necessary recovery context" without losing current-task
continuity. It must therefore be designed together with session, message chain, tool result,
memory, hooks, rewind, file checkpoint, resume and trace.

## 1. Internal design

### 1.1 Core concepts

ZCode v2 treats compact as a class of structured events in the session state machine, not a tool
function that directly mutates an array.

Core objects:

- `CompactBoundary`: a context breakpoint; history before it is covered by the summary.
- `CompactSummary`: the model-visible compressed summary carrying pre-boundary user intent, file
  changes, error fixes and current task state.
- `PostCompactContext`: the active context sent to the model after compaction.
- `PreservedSegment`: the original message range kept in partial or session-memory compaction.
- `CompactMetadata`: trigger, pre-compact tokens, summarized message count, kept ranges, summary
  source and trace info.

The canonical post-compact order is:

```text
compact boundary
compact summary
messages to keep
attachments
hook results
```

ZCode keeps this order semantics: declare the boundary first, then the summary, then the
original kept messages and recovery context. Session replay, resume, UI projection and provider
requests all understand compact through the same breakpoint model.

### 1.2 Trigger paths

Compact needs at least three trigger paths.

Automatic compact: judged per model request from the active-context token estimate. The policy
reserves buffer for summary output and later requests instead of waiting for a full window —
for example `effectiveContextWindow - reservedOutputTokens - compactBufferTokens` — as a
configurable policy that records the threshold source.

Manual compact: the user compresses the current context via a command. Manual compact may carry
summary instructions but never bypasses permission, hook, trace or persistence.

Partial compact: the user picks "summarize from here" or "summarize up to here" in a
rewind/message selector. This is not a rewind: it replaces one history range with a summary while
keeping another range of original messages.

Recursion protection is required before triggering: a compact's own summary model call must not
trigger compact again; session memory, summary agent and subagent forked queries also avoid
compacting each other via `querySource` or execution context.

#### 1.2.1 Local token estimation contract

Provider usage is the authority for context occupancy. Without a usage anchor, or for messages
added after computing the anchor, local character estimation uniformly reuses
`ESTIMATED_TOKEN_CHAR_DIVISOR = 3`, rounded up.

Message estimation covers text content, reasoning, and each assistant tool call's
`name + JSON.stringify(input ?? {})`. Tool call ids are not counted; tool results are already
counted through message content. A tool input that cannot be JSON-serialized counts as `{}` in
local estimation only, so the budget helper never interrupts compact or preflight; that
degradation changes neither tool execution nor persistence contracts.

### 1.3 Execution flow

A full compact runs:

1. Take the active messages after the latest compact boundary from the session projection.
2. Run light compression or budget trimming (tool result budget, microcompact, snip).
3. Check compact policy; manual compact proceeds directly.
4. Run the `PreCompact` hook, which may append controlled summary instructions or block compact.
5. Build the summary prompt. The summary agent outputs text only; tool calls are not allowed.
6. Call the provider for the summary, normalizing prompt-too-long, network interruption and
   no-text-output failures.
7. Create `CompactBoundary` and `CompactSummary`.
8. Generate post-compact recovery context: recent files, plan state, loaded skills, agent state,
   MCP/tool declarations, session-start hook results.
9. Write to the session event store and refresh the UI projection.
10. Run the `PostCompact` hook, record telemetry, clean stale caches.

Business core expresses only these state transitions and intent. Model requests, file reads,
session storage, hook subprocesses, network and logging all go through adapters.

### 1.4 Summary content requirements

A compact summary must stably cover:

- the user's explicit requests and constraints;
- key decisions made, option trade-offs and current assumptions;
- involved files, code locations, interfaces and data structures;
- errors that occurred, failure causes, fixes and user feedback;
- where the current task stands and what comes next;
- unfinished todos and paths that should not be retried;
- environment, permission, mode and tool state useful to later agents.

The summary prompt may ask the model for an internal analysis block first, but only the cleaned
summary enters the post-compact context. The summary agent's drafts are never pushed back into
the main context.

### 1.5 Microcompact versus full compact

Microcompact handles local context pressure only and is not a full compact.

Optional strategies:

- provider-neutral local microcompact: clean the provider-visible content of old tool results,
  keeping only placeholders, original size, tool id and traceable artifact/session references;
  the original transcript, tool parts and workspace checkpoints are untouched.
- time-based local microcompact: after long idle, when provider cache is expected to expire,
  proactively clear old tool results to cut the next request's rewrite cost.
- pressure-based local microcompact: when active context exceeds the microcompact threshold but
  not the full-compact threshold, clear old tool results first to avoid premature lossy
  summaries.
- provider-specific cached microcompact: only when the provider adapter explicitly declares
  support, use cache edit/reference to delete old tool results from the server-side cache; an
  optional optimization, never the main path.

Microcompact must not create a full `CompactBoundary` unless it truly changes the recoverable
message chain. It needs its own event type or metadata so resume/rewind do not misread it as a
history break.

Local microcompact is a pre-request active-context projection. It may replace the in-memory
provider-visible tool-result content but must not delete the original tool parts from the
session store; after resume, the same policy can re-project. On success it writes a
`microcompact_boundary`-equivalent event recording trigger, strategy, pre/post token estimate,
cleared/kept tool call ids and traceId. That event serves observation and UI only, never full
compact active-chain truncation.

### 1.6 Session memory compact

If ZCode introduces session memory, it is a summary source for compact, never a bypass of the
compact mechanism.

The session-memory path first: wait for in-progress memory extraction; validate the session
memory file is not an empty template; compute the messages already covered by memory from
`lastSummarizedMessageId`; keep recent messages so the scene is not reduced to a summary alone;
if still over threshold after compaction, fall back to traditional summary compact. This path
still produces the same `CompactBoundary`, `CompactSummary` and post-compact projection.

### 1.7 Persistence and recovery

Compact must enter the append-only session log. Mutating only an in-memory array would make
resume, continue, SDK and background tasks see different histories.

Persistence requirements:

- `CompactBoundary` is a logical breakpoint of the message chain.
- Messages before the boundary are covered by the summary in the active chain.
- If original messages are kept after compaction, a `PreservedSegment` is recorded so replay can
  relink the kept range after the summary or boundary.
- Pre-compact session metadata, title, tag, mode and worktree state are never lost to history
  trimming.
- Replay prefers building the post-compact chain; only corrupted relink metadata enters the
  conservative fallback.

On relink failure, choose not to prune — corrupted boundary metadata must not make history
unrecoverable. This conservative choice must log a structured warning and attribute the anomaly
to the same `traceId`.

### 1.8 Cleanup and cache invalidation

After compact, these states are usually cleared or rebuilt: read-file cache and file content
state; nested memory/instruction cache; system prompt section cache; microcompact tool-id state;
the permission classifier's short-term cache; the provider prompt-cache break detector baseline;
context-collapse or other context projection state; session message cache.

Cleanup must distinguish the main thread from subagents: a subagent compact must not clear
main-thread shared module-level state.

## 2. External requirements and side effects

### 2.1 User-facing behavior promise

ZCode describes compact externally as:

```text
清理旧对话历史，但保留一份可继续工作的上下文总结。
```

(Clears old conversation history but keeps a summary the work can continue from.)

The user must understand three things:

- after compact, the model relies mainly on the summary, not verbatim old history;
- the UI may still show history after compact, but showing history does not mean the model still
  sees it;
- the usable range of rewind, resume and file checkpoints may change after compact.

Manual compact may take extra summary requirements from the user (for example "keep test
output, file paths, failure reasons"). These enter the `PreCompact` instruction merge flow and
are recorded in compact metadata.

### 2.2 Event requirements for SDK / TUI / CLI

Compact emits structured events, not just text. Core is the source of truth for the compact
lifecycle and must not put TUI/ZCode app-server copy into events; it publishes only
machine-readable fields such as `status`, `trigger`, `phase`, `compactReason`, `display`, token
statistics, boundary/summary ids and failure reasons.

At minimum:

- `compact.started`
- `compact.progress`
- `compact.boundary.created`
- `compact.summary.created`
- `compact.completed`
- `compact.failed`

Events carry trigger, sessionId, turnId, traceId, pre/post token estimates, summary source,
whether original message ranges were kept, failure reason and retryability.

SDK consumers must recognize compact boundaries. TUI consumers must visually mark "a compaction
happened here". Non-interactive CLI writes the compact result into the transcript and returns a
machine-parseable status.

Compact timeline display rules are client projections:

- The TUI renders separator and status-line text from its own copy registry based on
  `status + trigger + display`.
- The ZCode app-server transport generates timeline metadata from the same structure for clients
  to recognize the synthetic timeline; where an external compatibility protocol needs a plain
  text fallback, that text is generated at the transport/client layer, never from a core payload.
- The session store may keep `timelineText` written by old versions for history compatibility,
  but newly written compact timeline parts no longer persist rendered copy.
- Replay prefers structured fields; legacy `timelineText` is a fallback only for old history
  lacking structured fields.

### 2.3 Config and permission requirements

ZCode-owned config and environment variables use the `ZCODE_` prefix.

Suggested config keys:

- `autoCompactEnabled`: enable automatic compact.
- `compact.maxSummaryOutputTokens`: summary output budget.
- `compact.bufferTokens`: auto compact trigger buffer.
- `compact.maxConsecutiveFailures`: auto compact failure circuit breaker count.
- `compact.preserveRecentTokens`: recent-context retention for session-memory or partial compact.

Debug and operations overrides declare no environment-variable entry; use config files,
CLI/session overrides or test injection. A new `ZCODE_` environment variable requires a spec
first, covering purpose, precedence, error behavior and tests.

Permission-wise compact itself is usually not dangerous, but it triggers provider requests, hook
execution, session writes and possibly file reads for recovery attachments. Its side-effect
scope includes at least `network`, `workspace`, `session-storage` and `user-visible-state`.

### 2.4 Effect on rewind

Compact directly affects rewind.

Conversation rewind depends on selectable user messages and the current active message chain.
After a full compact, user messages before the compact are usually no longer in the active chain;
even with UI scrollback retained, the model context and message selector follow the projection
after the latest boundary.

File rewind depends on the file-history snapshot anchored at a user message UUID. If that anchor
message has been compact-pruned, the checkpoint may be unrecoverable from the active chain after
resume. ZCode must fix a policy:

- whether pre-compact file checkpoints still appear in the UI;
- if shown, whether they can only restore files, not the conversation;
- if hidden, whether to explain "historical checkpoints are covered by compact";
- whether partial compact migrates checkpoint metadata onto the boundary or summary.

Default recommendation: after compact, only rewind to messages after the compact boundary is
promised. Pre-compact checkpoints may remain as advanced recovery but must carry a risk label
and never pretend to be a full conversation rewind.

### 2.5 Effect on resume / continue

Resume must restore the post-compact active chain, not the full old history; otherwise compact
works in-process but explodes tokens and changes behavior after restart.

Therefore:

- session replay must recognize the last `CompactBoundary`;
- pre-boundary history stays out of the active provider context by default;
- summary and preserved segments must suffice to recover the current task;
- if preserved-segment relinking fails, conservatively load the full history, log a warning and
  trigger a second compact or prompt the user soon.

### 2.6 Side effects on model behavior

Compact's main benefit is lower token pressure; its side effects are information loss and
semantic drift.

Possible problems:

- the summary omits user constraints and a later agent violates them;
- the summary marks unfinished tasks as finished;
- file paths, code snippets and error causes are over-generalized;
- after old tool results are cleared by microcompact, the model cannot re-check raw output;
- the summary invents facts, derailing later implementation;
- after compact, the prompt cache invalidates, raising the next request's cost and latency.

Mitigations:

- the summary prompt must emphasize explicit user requests, file paths, error fixes and current
  work;
- compact results keep a transcript path or artifact reference so the agent can consult old
  history;
- key tool results go to artifact/storage, not just the summary;
- the first turn after compact is observable: tokens, cache, summary size, whether compact
  immediately retriggers.

### 2.7 Side effects on hooks, memory, skills and tools

Hooks: `PreCompact` may modify summary instructions or block compact; `PostCompact` may notify
and audit. Hook failures must not corrupt the session log and always have structured errors and a
user-visible hint.

Memory: compact moves old messages out of the active chain. Memory extraction must know which
messages the summary already covers, or it re-summarizes or misses content.

Skills: key content of invoked skills must be re-injected after compact, or kept via a lighter
invoked-skill attachment. Every compact must not unboundedly resend all skill content.

Tools: deferred tool schemas, MCP instructions and agent listings must not depend on old history;
after compact they are re-declared by model request tools or an explicit delta attachment, or
the model loses tool context.

### 2.8 Observability and test requirements

Observation covers at least: trigger source (auto, manual, partial, reactive, session-memory);
pre/post token estimates; summary input/output/cache tokens; summarized/kept message counts and
recovered attachment counts; consecutive compacts or immediate re-thresholding; failure reason,
retry count, circuit-breaker trips; compact boundary consistency with replay/relink.

Tests cover at least:

- automatic threshold triggering and disabling via config;
- manual compact with custom instructions;
- summary request prompt-too-long retry during compact;
- session memory available/unavailable fallback;
- partial compact message order in both directions;
- post-compact rewind sees only the legal range;
- post-compact resume does not load trimmed history;
- preserved-segment relink success and failure fallback;
- subagent compact does not clear main-thread shared state.

### 2.9 Design principles

Compact is lossy but must never be unobservable.

ZCode v2 principles:

- lossy boundaries enter the session log explicitly;
- every cross-process, cross-recovery, cross-SDK compact result has a runtime schema;
- UI history display and provider active context stay layered, never conflated;
- rewind capability declares its range from the active chain and checkpoint metadata;
- compact failures bubble up by default to a layer that can handle them; only recoverable,
  retryable or degradable cases are caught;
- all compact subtasks inherit the same `traceId`.
