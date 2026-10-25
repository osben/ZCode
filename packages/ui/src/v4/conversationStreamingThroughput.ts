import { useEffect, useRef, useState } from "react";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";

/**
 * Streaming token estimate: deliberately matches the CLI-side `estimateTokens`
 * (apps/zcode-cli/packages/core/src/context/utils.ts): CJK characters count as 2 estimated characters, divided by the shared constant.
 * Changes to the formula must be made on both sides. This is a display estimate, not a protocol fact; the UI prefixes it with `~` to distinguish exact values.
 */
function estimateTokensFloat(text: string): number {
  const chineseChars = (text.match(/[一-鿿]/gu) || []).length;
  const otherChars = text.length - chineseChars;
  return (chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR;
}

export function estimateStreamingTokens(text: string): number {
  return Math.ceil(estimateTokensFloat(text));
}

export interface StreamingTokenEstimate {
  text: string;
  tokens: number;
}

/**
 * Incremental estimate: streaming text only appends at the end, so recalculating the full text for each delta makes long replies O(n²)
 * (tens of thousands of characters × several times per second). When the prefix is unchanged, estimate and accumulate only the new suffix;
 * when the prefix is rewritten (projection rebuild), recalculate the whole text.
 */
export function estimateIncrementalTokens(
  previous: StreamingTokenEstimate | null,
  text: string,
): StreamingTokenEstimate {
  if (!previous || !text.startsWith(previous.text)) {
    return { text, tokens: estimateTokensFloat(text) };
  }
  if (text.length === previous.text.length) return previous;
  return {
    text,
    tokens: previous.tokens + estimateTokensFloat(text.slice(previous.text.length)),
  };
}

export const STREAMING_THROUGHPUT_TICK_MS = 300;
/** Minimum observation time after the stream starts; publish nothing below it to avoid a fake speed from dividing by a tiny duration. */
export const STREAMING_THROUGHPUT_MIN_ELAPSED_MS = 500;
/** If the latest delta has been idle longer than this, treat the stream as paused (tool execution/request gap) and fall back to the exact value. */
export const STREAMING_THROUGHPUT_STALE_MS = 2_000;
/**
 * Maximum single delta. Real deltas are far smaller after projection frames; larger values can only come from a projection jump
 * (snapshot resync or old/new content briefly coexisting after stream recovery reopens a row). Restart measurement instead of
 * counting the jump as speed.
 */
export const MAX_STREAMING_TOKEN_JUMP = 12_000;

export interface StreamingThroughputState {
  /** Identity of the current set of streaming content; a change means the previous stream ended and a new one started. */
  key: string | null;
  /** Token count at the start of this measurement (completed content from an earlier segment is excluded from the numerator). */
  baselineTokens: number;
  /** Measurement start time; if the starting token count is 0, leave it empty until the first token arrives. */
  startedAtMs: number | null;
  /** Time of the latest token increase, used to detect idle streams. */
  lastGrowthAtMs: number;
  tokens: number;
}

export function createStreamingThroughputState(): StreamingThroughputState {
  return {
    key: null,
    baselineTokens: 0,
    startedAtMs: null,
    lastGrowthAtMs: 0,
    tokens: 0,
  };
}

function restartStreamingMeasurement(
  key: string | null,
  tokens: number,
  nowMs: number,
): StreamingThroughputState {
  return {
    key,
    baselineTokens: tokens,
    // Start measuring immediately when content already exists (for example, a reopened stream with text after projection rebuild); otherwise wait for the first token.
    startedAtMs: tokens > 0 ? nowMs : null,
    lastGrowthAtMs: nowMs,
    tokens,
  };
}

/**
 * Advances measurement state. Restart measurement when a new stream starts, text shrinks (projection rebuild), or a delta exceeds the physical limit (projection jump);
 * otherwise keep the same start and accumulate only the numerator.
 */
export function advanceStreamingThroughputState(
  state: StreamingThroughputState,
  input: { key: string | null; tokens: number; nowMs: number },
): StreamingThroughputState {
  const { key, tokens, nowMs } = input;
  if (state.key !== key) {
    return restartStreamingMeasurement(key, tokens, nowMs);
  }
  if (tokens < state.tokens || tokens - state.tokens > MAX_STREAMING_TOKEN_JUMP) {
    return restartStreamingMeasurement(key, tokens, nowMs);
  }
  if (state.startedAtMs === null) {
    if (tokens <= state.baselineTokens) {
      return { ...state, lastGrowthAtMs: nowMs, tokens };
    }
    // If tokens are first observed when measurement starts, their arrival time is unknown, so use them only as a baseline
    // and measure later additions. Otherwise the first batch would count entirely in the numerator, creating another false spike.
    return { ...state, baselineTokens: tokens, startedAtMs: nowMs, lastGrowthAtMs: nowMs, tokens };
  }
  return { ...state, lastGrowthAtMs: nowMs, tokens };
}

/**
 * Speed = **cumulative average** throughput since the start of this measurement (cumulative tokens / cumulative duration).
 * The cumulative measure is key: a burst of tokens increases the numerator once while the denominator covers the entire interval,
 * avoiding the tens of thousands tok/s that a short-window slope might report. Return null when idle, below the minimum duration, or when the delta is zero,
 * so the caller can fall back to the exact agent-side value.
 */
export function resolveStreamingTokensPerSecond(
  state: StreamingThroughputState,
  nowMs: number,
  options: {
    minElapsedMs?: number;
    staleMs?: number;
  } = {},
): number | null {
  const {
    minElapsedMs = STREAMING_THROUGHPUT_MIN_ELAPSED_MS,
    staleMs = STREAMING_THROUGHPUT_STALE_MS,
  } = options;
  if (state.startedAtMs === null) return null;
  if (nowMs - state.lastGrowthAtMs > staleMs) return null;
  const elapsedMs = nowMs - state.startedAtMs;
  if (elapsedMs < minElapsedMs) return null;
  const deltaTokens = state.tokens - state.baselineTokens;
  if (deltaTokens <= 0) return null;
  const tokensPerSecond = (deltaTokens * 1_000) / elapsedMs;
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : null;
}

/**
 * Content currently being streamed: body/reasoning uses `state === "streaming"`; tool input uses
 * `status === "inputStreaming"` (tool arguments written by the model are output tokens too).
 * Include only streaming rows, not completed history in the numerator—otherwise, during a multi-request work segment,
 * old text would create a false spike when the new request starts measuring.
 */
export function resolveSegmentStreamingContent(rows: readonly AssistantWorkRow[]): {
  key: string | null;
  text: string;
} {
  let key: string | null = null;
  let text = "";
  for (const row of rows) {
    if (row.kind === "reasoning" || row.kind === "assistantText") {
      if (row.state !== "streaming") continue;
      text += row.text;
    } else if (row.kind === "toolCall") {
      if (row.status !== "inputStreaming") continue;
      text += row.inputText;
    } else {
      continue;
    }
    key = key === null ? String(row.rowId) : `${key},${row.rowId}`;
  }
  return { key, text };
}

/**
 * Real-time streaming throughput (estimated). Recalculate cumulative average speed every 300ms while streaming;
 * return null when idle or below the minimum duration so the caller falls back to the exact value.
 */
export function useStreamingThroughput({
  enabled,
  contentKey,
  text,
}: {
  enabled: boolean;
  contentKey: string | null;
  text: string;
}): number | null {
  const stateRef = useRef<StreamingThroughputState>(createStreamingThroughputState());
  const estimateRef = useRef<StreamingTokenEstimate | null>(null);
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      stateRef.current = createStreamingThroughputState();
      estimateRef.current = null;
      setTokensPerSecond(null);
      return;
    }
    const nowMs = Date.now();
    const estimate = estimateIncrementalTokens(estimateRef.current, text);
    estimateRef.current = estimate;
    const state = advanceStreamingThroughputState(stateRef.current, {
      key: contentKey,
      tokens: estimate.tokens,
      nowMs,
    });
    stateRef.current = state;
    setTokensPerSecond(resolveStreamingTokensPerSecond(state, nowMs));
  }, [enabled, contentKey, text]);

  useEffect(() => {
    if (!enabled) return;
    // Timer tick: the cumulative average naturally converges over time and falls back after the stream is idle for the window.
    const timer = window.setInterval(() => {
      setTokensPerSecond(resolveStreamingTokensPerSecond(stateRef.current, Date.now()));
    }, STREAMING_THROUGHPUT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return tokensPerSecond;
}
