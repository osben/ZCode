import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTokensPerSecond,
  resolveLatestTokensPerSecond,
} from "../src/hooks/useSessionThroughput.js";
import {
  MAX_STREAMING_TOKEN_JUMP,
  advanceStreamingThroughputState,
  createStreamingThroughputState,
  estimateIncrementalTokens,
  estimateStreamingTokens,
  resolveStreamingTokensPerSecond,
} from "../src/v4/conversationStreamingThroughput.js";
import type { SessionDebugSnapshot } from "@zcode/shared";

function round(overrides: Partial<SessionDebugSnapshot["rounds"][number]>) {
  return {
    eventKey: "event-1",
    requestId: "request-1",
    requestIndex: 1,
    recordedAt: 1,
    usage: { inputTokens: 10, outputTokens: 100 },
    hitRate: null,
    generationDurationMs: 1000,
    tokensPerSecond: 100,
    ...overrides,
  } satisfies SessionDebugSnapshot["rounds"][number];
}

test("resolveLatestTokensPerSecond 只取末条 round，不回退旧值", () => {
  assert.equal(resolveLatestTokensPerSecond([]), null);
  assert.equal(resolveLatestTokensPerSecond([round({})]), 100);
  assert.equal(
    resolveLatestTokensPerSecond([
      round({ eventKey: "event-1", requestId: "request-1", tokensPerSecond: 100 }),
      round({ eventKey: "event-2", requestId: "request-2", tokensPerSecond: 42.5 }),
    ]),
    42.5,
  );
});

test("末条吞吐未知时保持缺席而不是冒充旧事实", () => {
  assert.equal(
    resolveLatestTokensPerSecond([
      round({ eventKey: "event-1", requestId: "request-1", tokensPerSecond: 100 }),
      round({
        eventKey: "event-2",
        requestId: "request-2",
        tokensPerSecond: null,
        generationDurationMs: null,
      }),
    ]),
    null,
  );
});

test("formatTokensPerSecond 与开发者面板 TPS 同格式：一位小数", () => {
  assert.equal(formatTokensPerSecond("en-US", 42.5), "42.5");
  assert.equal(formatTokensPerSecond("en-US", 100), "100");
  assert.equal(formatTokensPerSecond("en-US", 7.25), "7.3");
});

test("estimateStreamingTokens 与 CLI estimateTokens 同公式：中文双权重 ÷ 3", () => {
  // 6 English characters → 2 tokens.
  assert.equal(estimateStreamingTokens("abcdef"), 2);
  // 3 Chinese characters → 3×2/3 = 2 tokens.
  assert.equal(estimateStreamingTokens("思考中"), 2);
  // Empty text must not produce a negative number or NaN.
  assert.equal(estimateStreamingTokens(""), 0);
});

test("estimateIncrementalTokens 只累加新增后缀，前缀改写时全文重算", () => {
  const first = estimateIncrementalTokens(null, "abcdef");
  assert.equal(first.tokens, 2);
  const grown = estimateIncrementalTokens(first, "abcdef" + "ghijkl");
  assert.equal(grown.tokens, 4);
  // When the prefix changes (projection rebuild), recalculate the full text instead of reusing the previous total.
  const rebuilt = estimateIncrementalTokens(grown, "xyz");
  assert.equal(rebuilt.tokens, 1);
});

test("累计平均：突发到达不会算出数万 tok/s", () => {
  // Real sequence: the stream starts at 0, accumulates 1,000 tokens over 20 seconds, then jumps to 5,000 tokens at once.
  // The short-window slope yields 5000/0.05s = 100,000 tok/s; the cumulative average is only 6000/20s ≈ 307.
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 0,
  });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 50, nowMs: 1_000 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 1_000, nowMs: 20_000 });
  const burst = advanceStreamingThroughputState(state, {
    key: "row-1",
    tokens: 6_000,
    nowMs: 20_050,
  });
  const tps = resolveStreamingTokensPerSecond(burst, 20_050);
  assert.ok(tps !== null && tps < 400, `expected bounded tps, got ${tps}`);
});

test("起表后不足最短时长不发布，避免除以极小时间", () => {
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 1_000,
  });
  // Start timing when the first token arrives (the 50 tokens at this point are the baseline, not part of the numerator).
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 50, nowMs: 1_100 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 100, nowMs: 1_600 });
  // Do not publish at only 0 ms / 50 ms; otherwise 50 tokens / 0.05 s would produce a false 1000 tok/s.
  assert.equal(resolveStreamingTokensPerSecond(state, 1_100), null);
  assert.equal(resolveStreamingTokensPerSecond(state, 1_150), null);
  // After 500 ms, publish the cumulative average: 50 tokens / 0.5 s = 100.
  assert.equal(resolveStreamingTokensPerSecond(state, 1_600), 100);
});

test("静默超过窗口后回落（返回 null 交给精确值）", () => {
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 0,
  });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 500, nowMs: 10_000 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 1_000, nowMs: 10_500 });
  // 500 tokens / 0.5 s = 1000; the stream is still active.
  assert.equal(resolveStreamingTokensPerSecond(state, 10_500), 1_000);
  // After more than 2 s of silence, the stream is paused, so fall back to the exact value.
  assert.equal(resolveStreamingTokensPerSecond(state, 13_000), null);
});

test("新流开始重启测量：前一段已完成内容不计入分子", () => {
  // First stream: create the row (0 tokens), start timing at 500 tokens after 1 s, then reach 5000 total at 10 s.
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 0,
  });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 500, nowMs: 1_000 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 5_000, nowMs: 10_000 });
  // (5000-500) token / 9s = 500。
  assert.equal(resolveStreamingTokensPerSecond(state, 10_000), 500);
  // Second stream (thinking ends and the response begins): reset the start time and count the numerator from 0.
  state = advanceStreamingThroughputState(state, { key: "row-2", tokens: 5_000, nowMs: 20_000 });
  state = advanceStreamingThroughputState(state, { key: "row-2", tokens: 5_100, nowMs: 21_000 });
  // 100 tokens / 1 s = 100, not 5100 / 1 s = 5100.
  assert.equal(resolveStreamingTokensPerSecond(state, 21_000), 100);
});

test("文本回缩与投影跳变都重启测量，跳变不被算成速度", () => {
  const state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 1_000,
    nowMs: 10_000,
  });
  const shrunk = advanceStreamingThroughputState(state, {
    key: "row-1",
    tokens: 400,
    nowMs: 10_500,
  });
  assert.equal(shrunk.baselineTokens, 400);
  assert.equal(resolveStreamingTokensPerSecond(shrunk, 10_500), null);

  const jumped = advanceStreamingThroughputState(state, {
    key: "row-1",
    tokens: 1_000 + MAX_STREAMING_TOKEN_JUMP + 1,
    nowMs: 10_500,
  });
  assert.equal(jumped.baselineTokens, 1_000 + MAX_STREAMING_TOKEN_JUMP + 1);
  assert.equal(resolveStreamingTokensPerSecond(jumped, 10_500), null);
});
