import { describe, expect, it } from "vitest";
import {
  getAutoCompactThresholdTokens,
  getMicrocompactThresholdTokens,
  resolveContextBudgetTone,
} from "../src/contextBudgetPolicy.js";
import { sessionUsageStateSchema } from "../src/zcode-protocol-v4/snapshot.js";

describe("V4 session usage threshold compatibility", () => {
  it("preserves absent legacy thresholds separately from explicit disabled thresholds", () => {
    const legacy = sessionUsageStateSchema.parse({
      contextWindow: { usedTokens: 1_000, maxTokens: 200_000 },
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(legacy.contextWindow).not.toHaveProperty("autoCompactThresholdTokens");
    expect(legacy.contextWindow).not.toHaveProperty("microcompactThresholdTokens");

    const disabled = sessionUsageStateSchema.parse({
      contextWindow: {
        usedTokens: 1_000,
        maxTokens: 200_000,
        autoCompactThresholdTokens: null,
        microcompactThresholdTokens: null,
      },
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(disabled.contextWindow).toMatchObject({
      autoCompactThresholdTokens: null,
      microcompactThresholdTokens: null,
    });
  });
});

describe("context budget policy thresholds", () => {
  it("matches the runtime compaction math for a 200K window without max output", () => {
    // 200_000 - min(32_000, 21_000) - 13_000 = 166_000
    expect(getAutoCompactThresholdTokens({ contextWindow: 200_000 })).toBe(166_000);
    // min(floor(166_000 * 0.9), 166_000 - 2_000) = 149_400
    expect(getMicrocompactThresholdTokens({ contextWindow: 200_000 })).toBe(149_400);
  });

  it("reserves a smaller output budget when the model max output is below the cap", () => {
    // 200_000 - 8_000 - 13_000 = 179_000
    expect(getAutoCompactThresholdTokens({ contextWindow: 200_000, maxOutputTokens: 8_000 })).toBe(
      179_000,
    );
  });

  it("uses runtime buffer overrides and accepts a zero output reserve", () => {
    // 200_000 - 21_000 - 1_000 = 178_000
    expect(
      getAutoCompactThresholdTokens({
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        bufferTokens: 1_000,
      }),
    ).toBe(178_000);
    // An explicit zero output limit reserves no output tokens.
    expect(getAutoCompactThresholdTokens({ contextWindow: 200_000, maxOutputTokens: 0 })).toBe(
      187_000,
    );
  });

  it("clamps to zero when the window cannot fit the output reserve and buffer", () => {
    expect(getAutoCompactThresholdTokens({ contextWindow: 30_000 })).toBe(0);
    expect(getMicrocompactThresholdTokens({ contextWindow: 30_000 })).toBe(0);
  });

  it("returns zero thresholds for invalid windows", () => {
    expect(getAutoCompactThresholdTokens({ contextWindow: 0 })).toBe(0);
    expect(getAutoCompactThresholdTokens({ contextWindow: Number.NaN })).toBe(0);
    expect(getAutoCompactThresholdTokens({ contextWindow: 200_000, maxOutputTokens: -1 })).toBe(
      166_000,
    );
  });
});

describe("resolveContextBudgetTone", () => {
  const window = { contextWindow: 200_000 };

  it("stays normal below the microcompact threshold", () => {
    expect(resolveContextBudgetTone({ ...window, usedTokens: 149_399 })).toBe("normal");
    expect(resolveContextBudgetTone({ ...window, usedTokens: 1_000 })).toBe("normal");
  });

  it("warns from the microcompact threshold up to the auto-compact threshold", () => {
    expect(
      resolveContextBudgetTone({
        ...window,
        usedTokens: 149_400,
        autoCompactThresholdTokens: 166_000,
        microcompactThresholdTokens: 149_400,
      }),
    ).toBe("warning");
    expect(
      resolveContextBudgetTone({
        ...window,
        usedTokens: 165_999,
        autoCompactThresholdTokens: 166_000,
        microcompactThresholdTokens: 149_400,
      }),
    ).toBe("warning");
  });

  it("does not infer opt-in microcompact from legacy snapshots with an absent threshold", () => {
    expect(resolveContextBudgetTone({ ...window, usedTokens: 150_000 })).toBe("normal");
    // The legacy auto threshold estimate still applies independently.
    expect(resolveContextBudgetTone({ ...window, usedTokens: 166_000 })).toBe("critical");
  });

  it("treats a zero microcompact threshold as an immediate boundary", () => {
    expect(
      resolveContextBudgetTone({
        ...window,
        usedTokens: 1,
        microcompactThresholdTokens: 0,
      }),
    ).toBe("warning");
  });

  it("turns critical at the auto-compact threshold", () => {
    expect(resolveContextBudgetTone({ ...window, usedTokens: 166_000 })).toBe("critical");
    expect(resolveContextBudgetTone({ ...window, usedTokens: 199_999 })).toBe("critical");
  });

  it("uses runtime thresholds and respects independently disabled policies", () => {
    expect(
      resolveContextBudgetTone({
        ...window,
        usedTokens: 149_400,
        autoCompactThresholdTokens: 166_000,
        microcompactThresholdTokens: 150_000,
      }),
    ).toBe("normal");
    expect(
      resolveContextBudgetTone({
        ...window,
        usedTokens: 166_000,
        autoCompactThresholdTokens: 166_000,
        microcompactThresholdTokens: null,
      }),
    ).toBe("critical");
    expect(
      resolveContextBudgetTone({
        ...window,
        usedTokens: 166_000,
        autoCompactThresholdTokens: null,
        microcompactThresholdTokens: 149_400,
      }),
    ).toBe("warning");
    expect(
      resolveContextBudgetTone({
        ...window,
        usedTokens: 166_000,
        autoCompactThresholdTokens: null,
        microcompactThresholdTokens: null,
      }),
    ).toBe("normal");
  });

  it("treats invalid usage as normal", () => {
    expect(resolveContextBudgetTone({ ...window, usedTokens: 0 })).toBe("normal");
    expect(resolveContextBudgetTone({ ...window, usedTokens: Number.NaN })).toBe("normal");
  });
});
