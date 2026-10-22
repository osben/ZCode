import type { TokenizedCode } from "@/lib/shikiHighlighter.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createHighlighter = vi.fn();

vi.mock("shiki", async (importOriginal) => ({
  ...(await importOriginal<typeof import("shiki")>()),
  createHighlighter: (...args: unknown[]) => createHighlighter(...args),
}));

function createFakeHighlighter() {
  const codeToTokens = vi.fn((code: string) => ({
    fg: "#000",
    tokens: code.split("\n").map((line) => [{ content: line, color: "#000" }]),
  }));
  return {
    codeToTokens,
    highlighter: { getLoadedLanguages: () => ["typescript"], codeToTokens },
  };
}

async function loadHighlighter() {
  vi.resetModules();
  return import("@/lib/shikiHighlighter.js");
}

function highlightAsync(
  highlightCode: Awaited<ReturnType<typeof loadHighlighter>>["highlightCode"],
  code: string,
): Promise<TokenizedCode> {
  return new Promise((resolve, reject) => {
    const cached = highlightCode(code, "typescript", "github-light", resolve);
    if (cached) resolve(cached);
    setTimeout(() => reject(new Error("highlight timed out")), 1000);
  });
}

function flatContent(result: TokenizedCode): string {
  return result.tokens.map((line) => line.map((token) => token.content).join("")).join("\n");
}

describe("shikiHighlighter token cache", () => {
  beforeEach(() => {
    createHighlighter.mockReset();
  });

  it("does not return another block's tokens when only the middle of the code differs", async () => {
    const fake = createFakeHighlighter();
    createHighlighter.mockResolvedValue(fake.highlighter);
    const { highlightCode } = await loadHighlighter();
    const edge = "x".repeat(120);
    const first = `${edge}\nconst a = 1;\n${edge}`;
    const second = `${edge}\nconst b = 2;\n${edge}`;
    expect(first.length).toBe(second.length);

    expect(flatContent(await highlightAsync(highlightCode, first))).toBe(first);
    expect(flatContent(await highlightAsync(highlightCode, second))).toBe(second);
  });

  it("retries highlighter creation after a failed load instead of caching the rejection", async () => {
    const fake = createFakeHighlighter();
    createHighlighter
      .mockRejectedValueOnce(new Error("wasm load failed"))
      .mockResolvedValue(fake.highlighter);
    const { highlightCode } = await loadHighlighter();

    await expect(highlightAsync(highlightCode, "const failed = true;")).rejects.toThrow(
      "highlight timed out",
    );
    const result = await highlightAsync(highlightCode, "const retried = true;");

    expect(flatContent(result)).toBe("const retried = true;");
    expect(createHighlighter).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used tokens once the cache is full", async () => {
    const fake = createFakeHighlighter();
    createHighlighter.mockResolvedValue(fake.highlighter);
    const { highlightCode, SHIKI_TOKENS_CACHE_MAX_ENTRIES } = await loadHighlighter();

    await highlightAsync(highlightCode, "const kept = 0;");
    await highlightAsync(highlightCode, "const evicted = 0;");
    for (let index = 1; index < SHIKI_TOKENS_CACHE_MAX_ENTRIES - 1; index += 1) {
      await highlightAsync(highlightCode, `const filler${index} = ${index};`);
    }
    // A cache hit refreshes recency, so "kept" survives the next insertion and "evicted" does not.
    expect(highlightCode("const kept = 0;", "typescript", "github-light")).not.toBeNull();
    await highlightAsync(highlightCode, "const overflow = 1;");

    expect(highlightCode("const kept = 0;", "typescript", "github-light")).not.toBeNull();
    expect(highlightCode("const evicted = 0;", "typescript", "github-light")).toBeNull();
  });
});
