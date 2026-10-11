import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import {
  countContextPrefixMessages,
  createRuntimeAssistantEntry,
  createRuntimeUserEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
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
  const reasoning = result.reasoning?.filter(hasAssistantReasoningContent);
  const hasAssistantContent =
    state.modelResponse.length > 0 || (reasoning?.length ?? 0) > 0 || (toolCalls?.length ?? 0) > 0;
  if (!hasAssistantContent) return false;
  // Provider result metadata may report a different model; attribute the assistant using the Model already bound to the Turn
  // so the recovery chain does not reintroduce an old provider-owned model identity.
  const modelRef = { providerId: state.model.providerId, modelId: state.model.modelId };
  commitTurnRequestEntries(runtime, state.turnRequestState, [
    createRuntimeAssistantEntry(
      state.modelResponse,
      toolCalls,
      reasoning,
      modelRef,
      toTokenUsageInfo(result.usage),
    ),
  ]);
  return true;
}

export function hasAssistantReasoningContent(
  reasoning: NonNullable<RuntimeModelTextResult["reasoning"]>[number],
): boolean {
  return reasoning.text.length > 0 || Object.keys(reasoning.providerOptions ?? {}).length > 0;
}

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
