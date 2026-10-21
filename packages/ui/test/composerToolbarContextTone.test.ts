import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("V4 composer toolbar context usage wiring", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../src/v4/composer/V4ComposerToolbar.tsx"),
    "utf8",
  );

  it("forwards runtime compaction thresholds into taskUsage", () => {
    expect(source).toContain(
      "autoCompactThresholdTokens: contextWindow.autoCompactThresholdTokens",
    );
    expect(source).toContain("autoCompactThresholdAuthoritative: true");
    expect(source).toContain(
      "microcompactThresholdTokens: contextWindow.microcompactThresholdTokens",
    );
  });

  it("derives the usage tone from the runtime policy and exposes it", () => {
    expect(source).toContain("resolveContextBudgetTone({");
    expect(source).toContain("data-usage-tone={usageTone}");
  });
});
