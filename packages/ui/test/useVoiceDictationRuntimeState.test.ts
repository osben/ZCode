// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictationRuntimeState } from "@zcode/services";

const h = vi.hoisted(() => {
  const state = {
    runtime: {
      loadedModelId: "model-a",
      activeModelId: null,
      activePhase: null,
    } as VoiceDictationRuntimeState,
  };
  return {
    state,
    service: { getRuntimeState: vi.fn(async () => state.runtime) },
  };
});

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ voiceDictationService: h.service }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  retainVoiceDictationRuntimeActivity,
  useVoiceDictationRuntimeState,
} from "../src/hooks/useVoiceDictationRuntimeState.js";

describe("useVoiceDictationRuntimeState", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // The mock is shared across tests; later tests start from the default snapshot.
    h.state.runtime = { loadedModelId: "model-a", activeModelId: null, activePhase: null };
  });

  it("polls every 10 s while the Host is idle and every second while it is busy", async () => {
    vi.useFakeTimers();
    h.service.getRuntimeState.mockClear();
    h.state.runtime = { loadedModelId: null, activeModelId: null, activePhase: null };
    renderHook(() => useVoiceDictationRuntimeState());
    const calls = () => h.service.getRuntimeState.mock.calls.length;

    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2);

    // The next poll observes a load; from then on the cadence is one second.
    h.state.runtime = { loadedModelId: null, activeModelId: "model-a", activePhase: "loading" };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(6);
  });

  it("switches to the active cadence while a window-local operation is retained, then goes idle again", async () => {
    vi.useFakeTimers();
    h.service.getRuntimeState.mockClear();
    h.state.runtime = { loadedModelId: null, activeModelId: null, activePhase: null };
    renderHook(() => useVoiceDictationRuntimeState());
    const calls = () => h.service.getRuntimeState.mock.calls.length;

    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    // Retaining refreshes at once instead of waiting out the 10 s idle interval.
    const release = retainVoiceDictationRuntimeActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(5);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toBe(6);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls()).toBe(7);
  });

  it("gives a re-enabled view the current shared snapshot, not the one it last saw", async () => {
    vi.useFakeTimers();
    const observer = renderHook(() => useVoiceDictationRuntimeState());
    const subscriber = renderHook(
      ({ enabled }: { enabled: boolean }) => useVoiceDictationRuntimeState({ enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(subscriber.result.current.runtimeState.loadedModelId).toBe("model-a");

    // The subscriber stops listening while the model changes; only the observer sees it at its next
    // idle poll, which is 10 s away.
    subscriber.rerender({ enabled: false });
    h.state.runtime = { loadedModelId: "model-b", activeModelId: null, activePhase: null };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(observer.result.current.runtimeState.loadedModelId).toBe("model-b");

    // Re-enabling must show model-b at once: later polls equal the shared snapshot and would not notify.
    subscriber.rerender({ enabled: true });
    expect(subscriber.result.current.runtimeState.loadedModelId).toBe("model-b");
  });
});
