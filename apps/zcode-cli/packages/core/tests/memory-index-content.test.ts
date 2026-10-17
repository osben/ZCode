import { describe, expect, it } from "vitest";

import { formatMemoryIndexContent } from "../src/memory/index-content.js";

describe("formatMemoryIndexContent", () => {
  it("returns trimmed content unchanged within both limits", () => {
    expect(formatMemoryIndexContent("- [a](a.md) — hook\n")).toBe("- [a](a.md) — hook");
  });

  it("elides the middle at the line limit and keeps the newest tail entries", () => {
    const lines = Array.from({ length: 201 }, (_, index) => `- memory ${index + 1}`);
    const result = formatMemoryIndexContent(lines.join("\n"));

    expect(result).toContain("- memory 60\n\n…[MEMORY.md is over the 200-line cap; its middle is omitted]…\n\n- memory 62");
    expect(result).toContain("- memory 201\n\n> WARNING: MEMORY.md is 201 lines (limit: 200).");
    expect(result).not.toContain("- memory 61");
  });

  it("stays within the character cap with the marker and warns about entry length", () => {
    const result = formatMemoryIndexContent("x".repeat(25_600));

    expect(result).toContain("…[MEMORY.md is over the 24.4KB cap; its middle is omitted]…");
    expect(result).toContain(
      "> WARNING: MEMORY.md is 25KB (limit: 24.4KB) — index entries are too long.",
    );
    // head + marker + tail joins must stay within the cap.
    const keptEnd = result.indexOf("\n\n> WARNING:");
    expect(keptEnd).toBeLessThanOrEqual(25_000);
  });

  it("cuts whole lines only and biases the kept budget toward the tail", () => {
    const head = Array.from({ length: 110 }, (_, index) => `- old ${index + 1}`);
    const tail = Array.from({ length: 110 }, (_, index) => `- new ${index + 1}`);
    const result = formatMemoryIndexContent([...head, ...tail].join("\n"));

    expect(result).toContain(
      "- old 60\n\n…[MEMORY.md is over the 200-line cap; its middle is omitted]…\n\n- old 81",
    );
    expect(result).toContain("- new 110\n\n> WARNING: MEMORY.md is 220 lines (limit: 200).");
    expect(result).not.toContain("- old 61");
  });
});
