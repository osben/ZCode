# zcode-rs: context usage `cache`, `breakdown` and `microcompactThresholdTokens`

Follows `specs/fork-rust-background-and-context-usage.md` part 2 (`autoCompactThresholdAuthoritative`). The Rust v4
projection published `usage.contextWindow` with only `usedTokens`, `maxTokens`, `autoCompactThresholdTokens` and the
authority flag. Node also sends three optional fields (`packages/shared/src/zcode-protocol-v4/snapshot.ts:246-248`),
so the context usage panel on Rust had no cache line, no per-part breakdown and used a guessed microcompact warning.

## Node reference

- `microcompactThresholdTokens`: `resolveExecutionContextBudgetThresholds`
  (`apps/zcode-cli/packages/core/src/runtime/methods/compact.ts:326-357`). `null` when the compact policy is disabled
  or `compact.microcompact.enabled` is not `true`; otherwise the configured number, or the default derived from the
  auto threshold. Microcompaction only clears old tool results and is a separate trigger from auto compaction.
  Emitted on main-turn `ModelComplete` (`turn-model-step.ts:773-780`), projected at
  `bootstrap/src/zcode-protocol-v4/product-projection.ts:6155-6162`.
  The UI reads `null` as "disabled" and an absent field as "unknown", and for unknown it estimates a warning at 90% of
  the auto threshold (`packages/shared/src/contextBudgetPolicy.ts:140-150`).
- `cache`: `recordMainTurnCacheHitUsage` (`turn-model-step-usage.ts:121-172`), main-turn requests only, put in
  `ModelComplete.cacheHit` and projected as `usage.contextWindow.cache` (`product-projection.ts:6163`). Schema:
  `zcodeSessionContextCacheUsageSchema` (`zcode-protocol-legacy-types.ts:486`).
  `inputTokens` is the total input of the request (cache reads and writes included). A request whose input, cache
  read and cache write are all 0 is skipped. The running totals (`mainTurnCacheHitAggregate`) cover the session's
  active-branch assistant requests and are rebuilt from the stored messages on resume and rewind
  (`turn-model-step-usage.ts:80-119`).
- `breakdown`: `buildContextUsageSnapshot` (`context-usage.ts:162-226`) sizes the request with
  `classifyContextComposition` and projects it to 7 coarse sources with `projectContextCompositionToUsageSources`
  (`context-composition/classifier.ts:206-229`). `buildContextUsageBreakdownFromSnapshot` (`context-usage.ts:250-267`)
  keeps `{source, chars}` for each source whose chars are above 0. It goes into main-turn `ModelComplete` only when not
  empty (`model.ts:168`, `turn-model-step.ts:787`) and is projected at `product-projection.ts:6164-6166`.
  Sources: `system_prompt, meta_user_context, skills, tool_prompt, system_tool_schemas, mcp_tool_schemas, messages`.
  A deferred tool goes to `mcp_tool_schemas` when its name parses as `mcp__<server>__<tool>`, else to
  `system_tool_schemas` (`classifier.ts:322-334`, `parseMcpToolName`).
- A compaction rebuilds the window without `cache` and `breakdown` (`product-projection.ts:6295-6322`). A model switch
  keeps them (`invalidateResolvedContextBudgetThresholds` spreads the rest).

## What Rust does

- `rust_cli_query::composition` already measures each main-loop request the way Node does (`classify`,
  `usage_sources`, spec `specs/fork-rust-agent-parity.md`) for `v4/conversation/contextComposition`.
- No microcompaction exists in zcode-rs (nothing in `crates/` clears old tool results by a threshold).

## Rules

1. `microcompactThresholdTokens`: Rust does not microcompact, so the Node value for "microcompact off" is sent:
   `null`, on every non-null `contextWindow` (snapshot and `state.updated`). A number would be a threshold that does
   nothing. An absent field is wrong too: the UI would estimate a warning tone at 90% of the auto threshold for a
   feature Rust does not have. Revisit only if Rust gains microcompaction.
2. Owner of `cache` and `breakdown`: `Projection` (fields `cache_totals`, `request_breakdown`). Neither is a kernel
   fact the session actor keeps.
3. Input: `KernelEvent::ModelRequestCompleted` of a request with `QuerySource::MainThread` (Node `main_turn`; subagent,
   compact and side requests are ignored) and status `completed` (Node has no `ModelComplete` for a failed or
   cancelled request). The event is the one point where the request's usage and the request's own
   composition are together, so the query loop puts the coarse breakdown on `ModelCall.context_breakdown` (in memory,
   not stored: `serde` skips an empty list, and the usage table does not read it).
4. `breakdown` content: the same 7 sources and order as Node, from the request the session really sent (the same
   `Breakdown` the composition record is built from). A source is kept when its tokens are above 0 (Node's
   `total.tokens > 0`) and its chars are above 0. Deferred tools are split by name with Node's `parseMcpToolName`
   rule. An empty list is not published.
5. `cache` content, with `input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
   (Rust keeps the three apart; this is Node's provider-normalized total input):
   `inputTokens = input`, `cacheReadTokens`, `cacheWriteTokens`, `latestHitRate = cacheRead / input` (null when
   `input` is 0), the totals add each request, `hitRate = totalCacheRead / totalInput` (null when 0),
   `hitRateRequestCount` counts the requests that were not skipped. A completed main request without usage, or with
   all three counts 0, adds nothing to the totals and publishes no `cache` (Node leaves `cacheHit` out, and the
   projection takes `cache` from each completion alone), so it replaces an earlier `cache`. `breakdown` is replaced
   the same way.
6. Seed: `Projection::from_view_at` (cold open, rewind, edit, retry) sums the active-history assistant messages that
   carry usage, the same set Node rebuilds on resume. The seed alone publishes no `cache`: like Node, `cache` appears
   with the next completed main request. Active history decides membership only; the counts are the original stored
   tokens (Node `mainTurnCacheHitAggregateFromMessages`, `turn-model-step-usage.ts:80-119`). A compaction's preserved
   segment has its usage cleared in the active view (live: `history::active`, cold: node-records `invalidated`), so the
   seed reads each preserved message's original usage: live from the same message earlier in the session's history,
   cold from `LoadedSession.preserved_usage` (the stored rows before invalidation). Before: a reopened compacted session
   left the preserved requests out of `hitRateRequestCount` and the totals.
7. A published `cache` and `breakdown` stay until the next completed main request replaces them, through `ContextUsage` updates
   and model switches. `KernelEvent::CompactDone` drops both (the compacted history has no measured request yet); the
   running totals are kept, as Node keeps its aggregate.
8. Both fields only ride on a non-null `contextWindow`, in the one `state::usage` builder, so the snapshot and the
   patch carry the same values. A `state.updated {usage}` goes out when a main request completes.

```text
query loop: measure(request) ─► Timing.breakdown ─► ModelCall.context_breakdown
                                                         │ (MainThread only)
KernelEvent::ModelRequestCompleted ─► Projection.cache_totals += usage ─┐
                                      Projection.request_breakdown = ──┤
KernelEvent::CompactDone ─────────► both dropped                       │
state::usage(context, total, cache, breakdown) ◄───────────────────────┘ ─► snapshot / state.updated {usage}
```

## Acceptance

- A main request with usage 100 input, 20 cache write, 30 cache read, 10 output: `cache` is
  `{inputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 20, latestHitRate: 0.2, hitRate: 0.2,
hitRateRequestCount: 1, totalInputTokens: 150, totalCacheReadTokens: 30, totalCacheWriteTokens: 20}`; a second one
  adds to the totals.
- A subagent, compact or side request and a failed main request leave `cache` and `breakdown` alone. A completed main
  request with no usage or all-zero usage drops the published `cache`.
- `breakdown` lists the non-zero sources in ring order with their chars; a deferred `mcp__a__b` tool counts as
  `mcp_tool_schemas`, a deferred built-in as `system_tool_schemas`.
- `microcompactThresholdTokens` is `null` in the snapshot and in `state.updated`, with and without a threshold.
- `CompactDone` removes `cache` and `breakdown`; a later `ContextUsage` does not bring them back.
- A rebuilt projection seeds its totals from the history, so the next request's `hitRate` covers it.
- After a compaction with a preserved segment, the seed counts the preserved requests with their original usage, live and after a cold open (`node-store` load returns it).
- Every emitted `contextWindow` passes the strict zod schemas (field names and integer counts).

Coverage: `crates/protocol-zcode/src/projection/context_breakdown_tests.rs`,
`crates/query/src/composition_projection_tests.rs`, `crates/query/src/respond_metering_tests.rs`.

## Known differences

- Rust never microcompacts, so `microcompactThresholdTokens` is always `null` (rule 1). A user who turns on
  `compact.microcompact` in a Node-shared config gets no warning tone from it on Rust.
- Node attaches `cache` and `breakdown` on the same event as the usage; Rust sends them on
  `ModelRequestCompleted`, which the session actor emits after the usage row is stored, so the patch can follow the
  `ContextUsage` patch of the same request by one frame.
- Node's chars for the breakdown come from the request after provider projection; Rust sizes each history message on
  its own wire form (`composition::measure`), so a reminder folded into a tool result can move chars between
  `meta_user_context` and `messages`. The total is the same. This is the existing composition divergence.
- Rust has no `skills` or `tool_prompt` sections yet (composition spec), so those sources never appear.
- A cold open seeds the totals from the history; Node's `latestHitRate` and `cache` are absent until the first request
  after the open, and so are Rust's.
