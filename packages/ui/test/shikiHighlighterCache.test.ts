import type { TokenizedCode } from "@/lib/shikiHighlighter.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const { logger } = await import("@/logger.js");
  const loggerError = vi.spyOn(logger, "error").mockImplementation(() => {});
  return { ...(await import("@/lib/shikiHighlighter.js")), loggerError };
}

type HighlightCode = Awaited<ReturnType<typeof loadHighlighter>>["highlightCode"];

function highlightAsync(highlightCode: HighlightCode, code: string): Promise<TokenizedCode> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("highlight timed out")), 1000);
    const settle = (result: TokenizedCode) => {
      clearTimeout(timeout);
      resolve(result);
    };
    const cached = highlightCode(code, "typescript", "github-light", settle);
    if (cached) settle(cached);
  });
}

/** Mounts a highlight request and lets the async highlighter settle without waiting for a result. */
async function requestAndSettle(highlightCode: HighlightCode, code: string) {
  const callback = vi.fn();
  highlightCode(code, "typescript", "github-light", callback);
  await vi.runAllTimersAsync();
  return callback;
}

function flatContent(result: TokenizedCode): string {
  return result.tokens.map((line) => line.map((token) => token.content).join("")).join("\n");
}

describe("shikiHighlighter token cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createHighlighter.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("retries highlighter creation once after a failed load", async () => {
    const fake = createFakeHighlighter();
    createHighlighter
      .mockRejectedValueOnce(new Error("wasm load failed"))
      .mockResolvedValue(fake.highlighter);
    const { highlightCode } = await loadHighlighter();

    const failed = await requestAndSettle(highlightCode, "const failed = true;");
    const result = await highlightAsync(highlightCode, "const retried = true;");

    expect(failed).not.toHaveBeenCalled();
    expect(flatContent(result)).toBe("const retried = true;");
    expect(createHighlighter).toHaveBeenCalledTimes(2);
  });

  it("stops re-initializing a highlighter that keeps failing and logs each failure once", async () => {
    createHighlighter.mockImplementation(() => Promise.reject(new Error("wasm load failed")));
    const { highlightCode, loggerError, SHIKI_HIGHLIGHTER_MAX_ATTEMPTS } = await loadHighlighter();

    for (let mount = 0; mount < 6; mount += 1) {
      const callback = await requestAndSettle(highlightCode, `const attempt${mount} = ${mount};`);
      expect(callback).not.toHaveBeenCalled();
    }

    expect(createHighlighter).toHaveBeenCalledTimes(SHIKI_HIGHLIGHTER_MAX_ATTEMPTS);
    expect(loggerError).toHaveBeenCalledTimes(SHIKI_HIGHLIGHTER_MAX_ATTEMPTS);
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

  it("evicts old entries once the cached source exceeds the character budget", async () => {
    const fake = createFakeHighlighter();
    createHighlighter.mockResolvedValue(fake.highlighter);
    const { highlightCode, SHIKI_TOKENS_CACHE_MAX_CODE_CHARS } = await loadHighlighter();
    const large = (label: string) =>
      `// ${label}\n${"x".repeat(SHIKI_TOKENS_CACHE_MAX_CODE_CHARS / 2)}`;

    await highlightAsync(highlightCode, large("first"));
    await highlightAsync(highlightCode, large("second"));

    expect(highlightCode(large("second"), "typescript", "github-light")).not.toBeNull();
    expect(highlightCode(large("first"), "typescript", "github-light")).toBeNull();
  });
});
