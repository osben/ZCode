// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  PULL_REQUEST_STATUS_POLL_INTERVAL_MS,
  usePullRequestStatusPolling,
} from "@/hooks/usePullRequestStatusPolling.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("polls only while active, visible, and focused, and resumes on visibility", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const probe = vi.fn();
  const { unmount } = renderHook(() => usePullRequestStatusPolling(probe, true));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(PULL_REQUEST_STATUS_POLL_INTERVAL_MS);
  });
  expect(probe).toHaveBeenCalledTimes(1);

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PULL_REQUEST_STATUS_POLL_INTERVAL_MS);
  });
  expect(probe).toHaveBeenCalledTimes(1);

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(probe).toHaveBeenCalledTimes(2);

  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PULL_REQUEST_STATUS_POLL_INTERVAL_MS);
  });
  expect(probe).toHaveBeenCalledTimes(2);
});
