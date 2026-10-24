# Compact Phase and Memory Incremental Plan

## Document positioning

Incremental plan over `docs/design/v2/compact/README.md` and `plan.md` — compact phase semantics,
history replacement, context baseline and the memory read/write path. It does not replace the
main compact track.

Current implementation already has: the `/compact` manual entry; auto compact policy and failure
circuit breaker; reactive compact retry after provider context overflow; the compact summary
prompt, tool-call denial and prompt-too-long retry; the compact timeline part, summary message
and compact boundary events; resume restoring provider-visible history after the latest
compaction boundary; compact phase/compactReason metadata covering manual, pre-request, mid-turn
and reactive paths; and the memory read path (loading a lightweight summary from the project
`memory_summary.md` as dynamic system context, with skipped/loaded/failed logs).

The main gaps are not "no compact", but: post-compact in-memory provider-message replacement
lacks a stronger history-replacement abstraction; the context prefix is rebuilt every turn with
no reference context baseline/diff; the memory write path has no background
extraction/consolidation pipeline; and compact and memory lack an explicit boundary.

## Task status

The three compact phases mean the three core timing points: manual standalone compact, compact
before a new turn's first request, and compact before a follow-up request inside an agent turn.
The existing reactive compact retry is complementary and stays separately labeled
`reactive/provider_overflow`.

- [x] T1: `CompactPhase` and `CompactReason` in the contract; boundary/timeline payloads carry
  them optionally.
- [x] T2: `/compact` labeled `standalone_turn/user_requested`.
- [x] T3: auto compact after the user message and before the first provider request labeled
  `pre_request/context_limit`.
- [x] T4: auto compact before the next provider request caused by tool follow-up or pending
  input labeled `mid_turn/context_limit`.
- [x] T5: compact retry after provider context overflow labeled `reactive/provider_overflow`,
  excluded from the three-phase statistics.
- [x] T6: `mid_turn` tests prove compact happens after one model response completes and before
  the next sampling, never mid streaming delta.
- [ ] T7: converge summary persistence, boundary event, timeline completed and in-memory
  replacement into a `HistoryReplacement` installation flow.
- [x] T8: post-compact initial-context policy fixed — `pre_request` and `mid_turn` keep the
  existing context prefix in stage one; a reference context baseline/diff comes later.
- [x] T9: stage one implements only the memory read path, ensuring memory instructions survive
  compact or are rebuilt as part of the context prefix.
- [ ] T10: the memory write path must not consume synthetic compact summaries as the source of
  truth; prefer raw user messages, tool results and verification evidence.

## Phase and reason contract

```ts
export const CompactPhase = {
  StandaloneTurn: "standalone_turn",
  PreRequest: "pre_request",
  MidTurn: "mid_turn",
  Reactive: "reactive",
} as const;

export const CompactReason = {
  UserRequested: "user_requested",
  ContextLimit: "context_limit",
  ModelDownshift: "model_downshift",
  ProviderOverflow: "provider_overflow",
} as const;
```

Mapping:

| Path | trigger | phase | compactReason |
| --- | --- | --- | --- |
| `/compact` | `manual` | `standalone_turn` | `user_requested` |
| auto compact after the user message, before the first request | `auto` | `pre_request` | `context_limit` |
| auto compact before a tool follow-up | `auto` | `mid_turn` | `context_limit` |
| compact retry after provider overflow | `reactive` | `reactive` | `provider_overflow` |
| future model downgrade / small-window switch | `auto` | `pre_request` | `model_downshift` |

`CompactBoundaryPayload` and `CompactTimelinePayload` both include `phase` and `compactReason`.
The legacy `trigger` field stays so UI and reducers keep working. The timeline's existing
`reason` field stays reserved for failure/display reasons and is never reused for the compact
trigger reason.

## Mid-turn semantics

The runtime already runs auto compact before the next request in the tool loop; the phase is
identified explicitly via `modelStepCount`: `0` means `pre_request`, otherwise `mid_turn`. A
`mid_turn` compact that just ran tools or drained pending input continues into the next model
request.

Acceptance: a long task with tool calls whose second model request triggers auto compact emits
`phase = mid_turn`; no mid-turn compact fires after the final assistant text without a follow-up;
no compact ever fires mid streaming delta.

## History replacement (open, T7)

Today `messageHistory.replaceMessages(postCompactMessages)` is an in-memory replacement while
persistence relies on the summary message + compaction part. The next step converges it into an
explicit interface:

```ts
interface HistoryReplacement {
  boundary: CompactBoundaryPayload;
  replacementMessages: ModelInputMessage[];
  summaryMessageId: MessageId;
  preservedSegment?: CompactPreservedSegment;
  tokenUsageEstimate: {
    value: number;
    method: "estimated" | "provider_usage" | "provider_count";
  };
}
```

`compactActiveConversation` must not scatter writes across summary, boundary, timeline and
messageHistory; it produces a replacement that a session history service installs atomically,
with rollback behavior defined for installation failure. The current write shape may stay short
term, but spec and tests must come first so later partial compact, memory compact and resume
relink stay simple.

## Reference context baseline (open)

Goal: avoid re-injecting the full initial context every turn; inject a diff only when the
baseline changes. Today the context builder builds the full prefix at each initialization.

Two steps: first define `ContextBaseline` in the spec only
(`baselineId`, `turnId?`, `modelRef`, `cwd`, `permissionMode`, `userInstructionsHash?`,
`projectContextHash?`, `skillsHash?`, `memorySummaryHash?`); once compact/memory are stable,
split the builder into `buildInitialContext`, `buildContextDiff`, `recordContextBaseline` and
`clearContextBaselineAfterCompact`. A mid-turn compact that must immediately continue cannot
wait for the next initialization — replacement messages must keep or re-insert the needed
context prefix.

## Memory read path (landed)

Lightweight read path only; no background writes.

Directory layout:

```text
<storage.dir>/memories/
  memory_summary.md
  MEMORY.md
  skills/
  rollout_summaries/
```

Config: `features.memory` master switch; `memory.use` controls injecting read instructions;
`memory.root` derives from `storage.dir` by default (no new environment variables);
`memory.summaryTokenLimit` defaults to 5000.

The new context section: source `memory`, injection target `system` (first version; developer-side
instructions) or `meta_user`; content includes only `memory_summary.md` and retrieval rules, never
all memory files. The first version does not require XML citations from the model, but an
optional citation contract should be designed so the TUI or debug tooling can later trace which
memory files a turn used.

Landed files: `packages/core/src/runtime/methods/context.ts`,
`packages/core/src/context/sections/memory.ts`, `packages/core/tests/runtime-memory.test.ts`.
Reading is controlled by `features.memory`, `memory.use` and `memory.summaryMaxBytes`; a missing
or empty summary only logs a skipped debug entry.

## Memory write path (open, T10)

Background generation comes in a second stage, never shipped together with the read path.

Two phases:

```text
Phase 1:
  completed sessions/transcripts
  -> raw memory JSON/markdown
  -> state DB

Phase 2:
  raw memories
  -> memory workspace
  -> restricted consolidation agent
  -> MEMORY.md, memory_summary.md, skills/*, rollout_summaries/*
```

Limits:

- ephemeral sessions generate no memory; subagents generate none by default;
- the consolidation agent has memory disabled (no recursion) and a sandbox that only writes the
  memory root;
- memory updates are auditable, retryable and pausable;
- explicit user memory-update requests write to `extensions/ad_hoc/notes/`, never directly to
  `MEMORY.md`.

## Compact and memory relationship

Compact and memory are separate modules related through initial context and the transcript
evidence chain.

Read path: memory instructions are part of initial context. If a replacement history drops the
context prefix, the next model request loses the "how to query and cite memory" rules. Initial
context injection by phase:

- manual and `pre_request` compact: clear the reference baseline after compact so the next
  regular turn rebuilds full initial context; nothing is injected into the replacement history;
- `mid_turn` compact: the same turn continues with a model request immediately, so initial
  context must be re-inserted into the replacement history right away (before the last user
  message).

Even without a reference baseline/diff, this constraint must hold: after a `mid_turn` compact,
the next provider request's context prefix still contains system, project instructions, skills
and memory read instructions.

Write path: memory must not treat the compact summary as its only source of truth. Memory
extraction trusts raw user messages, tool calls/results and verification evidence from the
transcript, and excludes compaction artifacts, developer messages and reasoning. Rules:

- the compact summary may serve as a navigation hint for understanding a long session;
- long-term memory facts must come from raw transcripts, tool results, test outputs or explicit
  user preferences;
- the consolidation agent disables memory read/write by default so generation does not
  recursively pollute itself;
- compact boundaries and replacement histories stay persisted, since resume and later memory jobs
  may rely on them to rebuild an explainable session trace.

## Not doing now

- No provider-side remote compact APIs.
- No compact mid streaming delta.
- Not stuffing all memory files into every provider request.
- No automatic long-term memory writes from compact.
- No new `ZCODE_` environment variables.
- No shipping the memory write path together with the read path.

## Risks

- A mid-turn compact whose replacement context drops a tool call/result pair makes the next
  provider request invalid.
- A memory summary that is too broad pollutes every task; too narrow, it cannot guide retrieval.
- If phase/compactReason only goes to logs and not the contract, TUI and debug apps cannot
  consume them stably.
- Implementing context baseline/diff too early amplifies complexity; wait until phase and the
  memory read path are stable.
