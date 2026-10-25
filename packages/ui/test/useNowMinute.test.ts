// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW_MINUTE_INTERVAL_MS, useNowMinute } from "@/lib/taskListItemPresentation.js";

const START_MS = 1_000_000_000;

function setDocumentVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(document, "hidden");
});

describe("useNowMinute", () => {
  it("advances the value once per minute while visible", () => {
    const { result } = renderHook(() => useNowMinute());
    expect(result.current).toBe(START_MS);

    act(() => {
      vi.advanceTimersByTime(NOW_MINUTE_INTERVAL_MS - 1);
    });
    expect(result.current).toBe(START_MS);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(START_MS + NOW_MINUTE_INTERVAL_MS);
  });

  it("starts one shared interval for any number of subscribers", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const first = renderHook(() => useNowMinute());
      const second = renderHook(() => useNowMinute());
      const minuteTimers = setIntervalSpy.mock.calls.filter(
        ([, delay]) => delay === NOW_MINUTE_INTERVAL_MS,
      );
      expect(minuteTimers).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(NOW_MINUTE_INTERVAL_MS);
      });
      expect(first.result.current).toBe(START_MS + NOW_MINUTE_INTERVAL_MS);
      expect(second.result.current).toBe(START_MS + NOW_MINUTE_INTERVAL_MS);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does not tick while the document is hidden, and refreshes immediately when shown", () => {
    const { result } = renderHook(() => useNowMinute());

    setDocumentVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(NOW_MINUTE_INTERVAL_MS * 2);
    });
    expect(result.current).toBe(START_MS);

    setDocumentVisibility("visible");
    expect(result.current).toBe(START_MS + NOW_MINUTE_INTERVAL_MS * 2);

    act(() => {
      vi.advanceTimersByTime(NOW_MINUTE_INTERVAL_MS);
    });
    expect(result.current).toBe(START_MS + NOW_MINUTE_INTERVAL_MS * 3);
  });

  it("does not start a timer when mounted while hidden", () => {
    setDocumentVisibility("hidden");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const { result } = renderHook(() => useNowMinute());
      const minuteTimers = setIntervalSpy.mock.calls.filter(
        ([, delay]) => delay === NOW_MINUTE_INTERVAL_MS,
      );
      expect(minuteTimers).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(NOW_MINUTE_INTERVAL_MS * 5);
      });
      expect(result.current).toBe(START_MS);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
