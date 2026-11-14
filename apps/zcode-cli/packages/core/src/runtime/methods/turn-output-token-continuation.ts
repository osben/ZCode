import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import {
  buildAssistantEntries,
  countContextPrefixMessages,
  createRuntimeAssistantEntry,
  createRuntimeUserEntry,
  hasAssistantReasoningContent,
  withSignedReasoningReset,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  createProviderToolRoundEntries,
  hasProviderToolRoundContent,
  orderedAssistantHistoryBlocks,
  providerToolRoundsCompactGroupKey,
  withCompactGroupKey,
} from "../provider-tool-rounds/contract.js";
import type { RegularTurnLoopState, TurnRequestState } from "./turn-loop-state.js";

export const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export const OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE =
  "The model's response exceeded the output token maximum.";

const MAX_OUTPUT_TOKEN_CONTINUATIONS = 3;
const OUTPUT_LIMIT_RAW_REASONS = new Set([
  "max_tokens",
  "max_output_tokens",
  "model_context_window_exceeded",
]);

type OutputTokenContinuationDecision = "continue" | "exhausted" | "none";

export function classifyOutputTokenContinuation(input: {
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
  toolCallCount: number;
  continuationCount: number;
}): OutputTokenContinuationDecision {
  if (input.toolCallCount > 0) return "none";
  if (!isOutputTokenLimitFinishReason(input.finishReason, input.rawFinishReason)) {
    return "none";
  }
  return input.continuationCount < MAX_OUTPUT_TOKEN_CONTINUATIONS ? "continue" : "exhausted";
}

export function isOutputTokenLimitFinishReason(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
): boolean {
  // Intentional design (not a bug): model_context_window_exceeded on a successful response is treated as Continue.

  // Even an entirely empty content response shares the limit of at most 3 recoveries.
  // Anthropic allows input to fit while input + max_tokens exceeds the window; generation that fills the window truncates a successful response.
  // This differs from a request failure caused by input alone exceeding the window, so do not convert it to an exception by name and trigger Reactive Compact first.
  // Behavior change: previously this successful stop reason triggered Reactive Compact immediately. Now save the partial,
  // append Continue, and return to the outer loop to check Micro/Auto Compact, compacting before continuation if needed.
  // If continuation throws a real overflow exception, retry that continuation after successful Reactive Compact or fail if recovery is impossible.
  // Compaction does not append another Continue or reset the count; the limit of three excludes compaction requests and exception retries.
  // If the fourth response is still successfully truncated, report an output limit error without another Reactive Compact attempt.
  // Therefore, if the server keeps returning this marker and local automatic compaction does not trigger, repeated ineffective continuations may exhaust the limit.
  // This preserves the existing contract to continue first and compact only when needed; it does not guarantee that the next continuation succeeds.
  return finishReason === "length" || OUTPUT_LIMIT_RAW_REASONS.has(rawFinishReason ?? "");
}

function createOutputTokenContinuationEntry(): RuntimeMessageEntry {
  return {
    ...createRuntimeUserEntry(OUTPUT_TOKEN_CONTINUE_PROMPT),
    queryScope: "output_token_continuation",
  };
}

function isOutputTokenContinuationEntry(entry: RuntimeMessageEntry): boolean {
  return entry.kind !== "attachment" && entry.queryScope === "output_token_continuation";
}

export function filterOutputTokenContinuationEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const firstContinuation = entries.findIndex(isOutputTokenContinuationEntry);
  if (firstContinuation < 0) return entries;
  return entries.filter((entry) => !isOutputTokenContinuationEntry(entry));
}

export function preserveCanonicalContextPrefix(
  currentCanonicalEntries: readonly RuntimeMessageEntry[],
  turnLocalEntries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  // Configuration refresh immediately replaces the canonical prefix, while the recovery chain retains the atomic Turn's old
  // prefix. Writing back the whole value from turn-local Compact would undo the refresh, so commit only the transformed conversation tail.
  return [
    ...currentCanonicalEntries.slice(0, countContextPrefixMessages(currentCanonicalEntries)),
    ...turnLocalEntries.slice(countContextPrefixMessages(turnLocalEntries)),
  ];
}

export function appendTurnRequestEntries(
  state: TurnRequestState,
  entries: readonly RuntimeMessageEntry[],
): void {
  if (entries.length === 0) return;
  state.entries = [...state.entries, ...entries];
}

export function commitTurnRequestEntries(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  entries: readonly RuntimeMessageEntry[],
): void {
  if (entries.length === 0) return;
  runtime.messageHistory.addEntries(entries);
  appendTurnRequestEntries(state, entries);
}

export function commitAssistantToTurnRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: RuntimeModelTextResult,
  toolCalls: Parameters<typeof createRuntimeAssistantEntry>[1],
): boolean {
  // provider result metadata 可能报告别的模型；assistant 归因必须使用
  // Turn 已绑定的 Model，避免恢复链重新引入旧的 provider-owned 模型身份。
  const modelRef = { providerId: state.model.providerId, modelId: state.model.modelId };
  const orderedBlocks = orderedAssistantHistoryBlocks(result, toolCalls);
  if (orderedBlocks) {
    // 有序结果与冷恢复共用 buildAssistantEntries，live 与冷恢复的条目相同。
    const entries = buildAssistantEntries({
      blocks: orderedBlocks,
      model: modelRef,
      tokens: toTokenUsageInfo(result.usage),
      groupKey: providerToolRoundsCompactGroupKey(result.providerToolRounds),
    });
    // 签名修复后成功的请求同样在第一条 assistant 上记标记；冷恢复的有序分支按消息 metadata
    // 对 buildAssistantEntries 的结果做同样处理，两边条目一致。
    commitTurnRequestEntries(runtime, state.turnRequestState, markRepairedStep(entries, result));
    return entries.length > 0;
  }
  const reasoning = result.reasoning?.filter(hasAssistantReasoningContent);
  const hasFinalRoundContent =
    state.modelResponse.length > 0 || (reasoning?.length ?? 0) > 0 || (toolCalls?.length ?? 0) > 0;
  const hasProviderRounds = hasProviderToolRoundContent(result.providerToolRounds);
  if (!hasFinalRoundContent && !hasProviderRounds) return false;
  // 服务端内置工具切出的前序轮次排在最后一轮之前，每轮自带调用与结果。
  const providerRoundEntries = createProviderToolRoundEntries(
    result.providerToolRounds,
    modelRef,
    hasAssistantReasoningContent,
  );
  // The earlier rounds and the final round belong to one persisted assistant; compact must count them as one group.
  const compactGroupKey = providerToolRoundsCompactGroupKey(result.providerToolRounds);
  // With server-side built-in tool rounds present, provider usage is the sum of the server's
  // internal multi-round requests (roughly the round count times a single context) and cannot
  // serve as a context estimation anchor; attach no tokens, so estimation falls back to the
  // last real anchor plus the local delta. Cold restore attaches none either.
  const contextUsage = compactGroupKey ? undefined : toTokenUsageInfo(result.usage);
  const stepEntries = hasFinalRoundContent
    ? [
        ...providerRoundEntries,
        createRuntimeAssistantEntry(
          state.modelResponse,
          toolCalls,
          reasoning,
          modelRef,
          contextUsage,
        ),
      ]
    : providerRoundEntries;
  commitTurnRequestEntries(
    runtime,
    state.turnRequestState,
    withCompactGroupKey(markRepairedStep(stepEntries, result), compactGroupKey),
  );
  return true;
}

/** 签名修复后成功的请求：在这一步产出的第一条 assistant 上记标记（见 withSignedReasoningReset）。 */
export function markRepairedStep(
  entries: readonly RuntimeMessageEntry[],
  result: Pick<RuntimeModelTextResult, "signedReasoningReset">,
): RuntimeMessageEntry[] {
  return result.signedReasoningReset ? withSignedReasoningReset(entries) : [...entries];
}

export { hasAssistantReasoningContent };

export function appendOutputTokenContinuation(state: TurnRequestState): void {
  appendTurnRequestEntries(state, [createOutputTokenContinuationEntry()]);
  state.outputTokenContinuationCount += 1;
}

export function completeOutputTokenRecovery(state: TurnRequestState): void {
  state.outputTokenContinuationCount = 0;
}

export function finishOutputTokenRecovery(state: TurnRequestState): void {
  completeOutputTokenRecovery(state);
}
