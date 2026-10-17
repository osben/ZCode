import { describe, expect, it } from "vitest";

import { formatMemoryIndexContent } from "../src/memory/index-content.js";

describe("formatMemoryIndexContent", () => {
  it("returns trimmed content unchanged within both limits", () => {
    expect(formatMemoryIndexContent("- [a](a.md) — hook\n")).toBe("- [a](a.md) — hook");
  });

  it("elides the middle at the line limit and keeps the newest tail entries", () => {
    const lines = Array.from({ length: 201 }, (_, index) => `- memory ${index + 1}`);
    const result = formatMemoryIndexContent(lines.join("\n"));

    expect(result).toContain("- memory 59\n\n…[MEMORY.md is over the 200-line cap; its middle is omitted]…\n\n- memory 64");
    expect(result).toContain("- memory 201\n\n> WARNING: MEMORY.md is 201 lines (limit: 200).");
    expect(result).not.toContain("- memory 60");
    // The marker line and its two blank separators count toward the line cap.
    const keptEnd = result.indexOf("\n\n> WARNING:");
    expect(result.slice(0, keptEnd).split("\n").length).toBeLessThanOrEqual(200);
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

  it("retains bounded slices of a single oversized line instead of dropping the entry", () => {
    const result = formatMemoryIndexContent(`- single entry ${"x".repeat(25_600)}`);
    const marker = "…[MEMORY.md is over the 24.4KB cap; its middle is omitted]…";
    const markerIndex = result.indexOf(marker);

    // The head keeps a bounded leading slice of the oversized line, the tail a trailing slice —
    // not an empty side with only the marker and warning left.
    expect(result.slice(0, markerIndex)).toMatch(/^- single entry x+\n\n$/u);
    expect(result.slice(markerIndex + marker.length)).toMatch(/^\n\nx+/u);
    const keptEnd = result.indexOf("\n\n> WARNING:");
    expect(keptEnd).toBeLessThanOrEqual(25_000);
  });

  it("cuts whole lines only and biases the kept budget toward the tail", () => {
    const head = Array.from({ length: 110 }, (_, index) => `- old ${index + 1}`);
    const tail = Array.from({ length: 110 }, (_, index) => `- new ${index + 1}`);
    const result = formatMemoryIndexContent([...head, ...tail].join("\n"));

    expect(result).toContain(
      "- old 59\n\n…[MEMORY.md is over the 200-line cap; its middle is omitted]…\n\n- old 83",
    );
    expect(result).toContain("- new 110\n\n> WARNING: MEMORY.md is 220 lines (limit: 200).");
    expect(result).not.toContain("- old 60");
  });

  it("enforces the line cap alongside the character cap with short entries", () => {
    const lines = Array.from(
      { length: 250 },
      (_, index) => `- entry ${String(index + 1).padStart(3, "0")} ${"x".repeat(108)}`,
    );
    const result = formatMemoryIndexContent(lines.join("\n"));

    const marker = "…[MEMORY.md is over the 24.4KB cap; its middle is omitted]…";
    const [head, afterMarker] = result.split(marker);
    // The line cap binds before the character budget on both sides of the elision.
    expect(head).toContain("- entry 059");
    expect(head).not.toContain("- entry 060");
    expect(afterMarker.slice(0, afterMarker.indexOf("\n\n> WARNING:"))).toContain("- entry 113");
    expect(result).not.toContain("- entry 112");
    expect(result).toContain("- entry 250 ");

    const keptEnd = result.indexOf("\n\n> WARNING:");
    expect(keptEnd).toBeLessThanOrEqual(25_000);
    expect(result.slice(0, keptEnd).split("\n").length).toBeLessThanOrEqual(200);
  });
});
