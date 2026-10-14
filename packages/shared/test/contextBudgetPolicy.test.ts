import { describe, expect, it } from "vitest";
import {
  getAutoCompactThresholdTokens,
  getMicrocompactThresholdTokens,
  resolveContextBudgetTone,
} from "../src/contextBudgetPolicy.js";

describe("context budget policy thresholds", () => {
  it("matches the runtime compaction math for a 200K window without max output", () => {
    // 200_000 - min(32_000, 21_000) - 13_000 = 166_000
    expect(getAutoCompactThresholdTokens({ contextWindow: 200_000 })).toBe(166_000);
    // floor(166_000 * 0.9) - 2_000 = 147_400
    expect(getMicrocompactThresholdTokens({ contextWindow: 200_000 })).toBe(147_400);
  });

  it("reserves a smaller output budget when the model max output is below the cap", () => {
    // 200_000 - 8_000 - 13_000 = 179_000
    expect(getAutoCompactThresholdTokens({ contextWindow: 200_000, maxOutputTokens: 8_000 })).toBe(
      179_000,
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
    expect(resolveContextBudgetTone({ ...window, usedTokens: 147_399 })).toBe("normal");
    expect(resolveContextBudgetTone({ ...window, usedTokens: 1_000 })).toBe("normal");
  });

  it("warns from the microcompact threshold up to the auto-compact threshold", () => {
    expect(resolveContextBudgetTone({ ...window, usedTokens: 147_400 })).toBe("warning");
    expect(resolveContextBudgetTone({ ...window, usedTokens: 165_999 })).toBe("warning");
  });

  it("turns critical at the auto-compact threshold", () => {
    expect(resolveContextBudgetTone({ ...window, usedTokens: 166_000 })).toBe("critical");
    expect(resolveContextBudgetTone({ ...window, usedTokens: 199_999 })).toBe("critical");
  });

  it("treats invalid usage as normal", () => {
    expect(resolveContextBudgetTone({ ...window, usedTokens: 0 })).toBe("normal");
    expect(resolveContextBudgetTone({ ...window, usedTokens: Number.NaN })).toBe("normal");
  });
});
