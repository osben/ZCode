// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: null as { voiceDictation?: Record<string, unknown> } | null,
  warn: vi.fn(),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: mocks.warn } }));

import { useDictationTranscriptHandler } from "@/hooks/useDictationTranscriptHandler.js";

const writeText = vi.fn();

beforeEach(() => {
  mocks.settings = { voiceDictation: {} };
  mocks.warn.mockClear();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDictationTranscriptHandler", () => {
  it("only inserts when copyToClipboard is off", () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictationTranscriptHandler(onTranscript));

    result.current("Hello there");

    expect(onTranscript).toHaveBeenCalledWith("Hello there");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("inserts and also copies the transcript when copyToClipboard is on", () => {
    mocks.settings = { voiceDictation: { copyToClipboard: true } };
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictationTranscriptHandler(onTranscript));

    result.current("Hello there");

    expect(onTranscript).toHaveBeenCalledWith("Hello there");
    expect(writeText).toHaveBeenCalledWith("Hello there");
  });

  it("inserts the processed text but puts the raw transcript on the clipboard", () => {
    mocks.settings = { voiceDictation: { copyToClipboard: true } };
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictationTranscriptHandler(onTranscript));

    result.current("Hello there.", "hello there");

    expect(onTranscript).toHaveBeenCalledWith("Hello there.");
    expect(writeText).toHaveBeenCalledWith("hello there");
  });

  it("keeps the insertion when the clipboard write is rejected and only logs it", async () => {
    mocks.settings = { voiceDictation: { copyToClipboard: true } };
    writeText.mockRejectedValue(new Error("Document is not focused"));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictationTranscriptHandler(onTranscript));

    result.current("Hello there");
    await Promise.resolve();
    await Promise.resolve();

    expect(onTranscript).toHaveBeenCalledWith("Hello there");
    expect(mocks.warn).toHaveBeenCalledWith(
      "voice dictation clipboard copy failed",
      expect.objectContaining({ error: "Document is not focused" }),
    );
  });

  it("keeps the insertion when the clipboard API is missing", () => {
    mocks.settings = { voiceDictation: { copyToClipboard: true } };
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictationTranscriptHandler(onTranscript));

    expect(() => result.current("Hello there")).not.toThrow();
    expect(onTranscript).toHaveBeenCalledWith("Hello there");
  });

  it("returns a stable handler while the inputs do not change", () => {
    const onTranscript = vi.fn();
    const { result, rerender } = renderHook(() => useDictationTranscriptHandler(onTranscript));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
