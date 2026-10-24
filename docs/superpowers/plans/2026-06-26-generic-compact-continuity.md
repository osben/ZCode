# Generic Compact Provider-Visible Convergence

> Historical implementation plan (2026-06-26), kept as the compact provider-visible contract.
> Implementation: `apps/zcode-cli/packages/core/src/compact/` (prompt, policy),
> `runtime/helpers/compact-*.ts`, `runtime/methods/compact-active*.ts`; tests in
> `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts` and `compact-policy.test.ts`.

**Goal:** keep the generic compaction flow (compact prompt, summary post-processing, post-compact
context assembly) coherent so work continues safely after compact. No model-specific branches,
policies, or config switches; everything lands in the generic compact path.

## Compact Request Shape

- Compact summary requests expose the normal tool list (same shape as a regular turn), never
  `tools: []`; `ModelRequest` event `toolCount` reflects the exposed tools.
- Compact execution stays single-turn summary-only. Any model tool call during compact is denied
  before execution: `formatCompactSummaryOrThrow` throws `CoreErrorType.ModelError` with
  `Tool use is not allowed during compaction`; no tool result part is persisted and no
  `ToolExecutor` is scheduled.
- Full prompt anchors (verbatim, asserted by tests): `CRITICAL: Respond with TEXT ONLY. Do NOT
  call any tools.`, `Tool calls will be REJECTED`, preserve security-relevant constraints
  verbatim, `Current Work`, `Optional Next Step`.
- `formatCompactSummary("<analysis>…<summary>abc</summary>")` produces `Summary:\nabc`;
  `buildCompactSummaryMessage` accepts `{ suppressFollowup, transcriptPath,
  recentMessagesPreserved, replStateCleared }` and appends `Resume directly` continuation text
  when `suppressFollowup` is set. Transcript recovery text is only injected when ZCode actually
  has a transcript path capability.

## Recent Group Preservation

- Auto (`CompactTrigger.Auto`) and reactive (`CompactTrigger.Reactive`) compact summarize older
  turns but preserve the newest complete conversation group (assistant tool calls kept with
  their tool results) plus trailing pending user entries verbatim in the post-compact context.
- A pending user request that triggers auto compact is excluded from the summary request and
  included in the post-compact request.
- Preserved messages are not summarized via a recent-only prompt; the full compact prompt is
  used, and recent entries re-enter through post-compact context assembly.
- Compact boundary metadata records `keptMessageCount`, `groupsPreserved`, `totalGroups`.

## Post-Compact Continuity Reminders

- Read-state: after compact, a model-only reminder re-injects recently read files from
  `readFileState` (sorted by most recent read; capped at 5 files, ~50k total tokens, ~5k per
  file). A too-large file yields exactly:
  `Note: <path> was read before the last conversation was summarized, but the contents are too
  large to include. Use Read tool if you need to access it.`
  Plan file, memory files, and denied paths are never exposed through this reminder.
- Todo state: compact does not restore todo state into provider-visible context
  (`Current session todo state (authoritative):` must not appear in summary bodies); the generic
  todo reminder cadence applies afterwards.
- Plan file continuity is handled by the dedicated `plan_file_reference` reminder (see
  `docs/plan-mode-plan-file-compact-continuity.md`), not by read-state reminders.

## Budget Policy

- Compact summary request max output is capped at 20k:
  `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` (bounded by the model's max output cap).
- The auto-compact budget must reserve compact prompt text, exposed tool schemas, and summary
  max output so auto compact does not trigger into a predictable context overflow.
- `AutoCompactDecision` diagnostics expose the budget facts needed to debug failures:
  `contextWindow`, `effectiveContextWindow`, `threshold`, `tokenCount`, `tokenSource`,
  provider usage fields, `outputReserveTokens`, and summary cap.
- Accepted defaults were frozen as 64k output reserve and a 90 percent threshold in this plan;
  current `compact/policy.ts` sets `DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100` — the policy
  constants live in `@zcode/shared` and have since evolved.

## Media Handling

- Compact requests pass through the same media capability/budget projection as normal turns
  (`projectMessagesForModelMediaPolicy`): explicitly unsupported media is replaced by the
  neutral omission text; compact stays text-only via `maxMediaBytes: 0` regardless of
  capabilities.

## UI Invariant

- The UI projection renders compact as exactly one `context_compaction` divider;
  `isZCodeCompactSummaryMessage` keeps the model-only summary message out of the chat and it is
  never rendered as a user bubble. Preserved real user messages stay visible.

## Explicit Skips (still excluded)

- Provider/server-side compaction: Anthropic API `context_management`, `compact_20260112`,
  `compaction_delta`, SDK `compactionControl`, cache edit/cache write/cache sharing.
- External `PreCompact` / `PostCompact` hooks; REPL VM copy (no such state in ZCode).
- Local microcompact changes: microcompact depends on a `context_hint`/server capability ZCode
  does not have; it stays opt-in with safety fixes only, and full compact must not depend on
  microcompact being enabled.
