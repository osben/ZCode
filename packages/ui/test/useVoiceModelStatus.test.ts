// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  service: null as { getRuntimeState: ReturnType<typeof vi.fn> } | null,
  settings: null as { voiceDictation?: Record<string, unknown> } | null,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ voiceDictationService: mocks.service }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

import { useVoiceModelStatus } from "@/hooks/useVoiceModelStatus.js";

beforeEach(() => {
  mocks.settings = { voiceDictation: { modelId: "model-one" } };
  mocks.service = {
    getRuntimeState: vi
      .fn()
      .mockResolvedValue({ loadedModelId: "model-one", activeModelId: null, activePhase: null }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useVoiceModelStatus", () => {
  it("reports the selected model's status from the Host runtime snapshot", async () => {
    const { result } = renderHook(() => useVoiceModelStatus({ enabled: true }));
    expect(result.current).toBe("idle");
    await waitFor(() => expect(result.current).toBe("loaded"));
  });

  it("does not poll the Host when disabled", async () => {
    const { result } = renderHook(() => useVoiceModelStatus({ enabled: false }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.service!.getRuntimeState).not.toHaveBeenCalled();
    expect(result.current).toBe("none");
  });

  it("skips the Host call while the window is hidden", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderHook(() => useVoiceModelStatus({ enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.service!.getRuntimeState).not.toHaveBeenCalled();
  });

  it("shares one Host poll across mounted views", async () => {
    renderHook(() => useVoiceModelStatus({ enabled: true }));
    renderHook(() => useVoiceModelStatus({ enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.service!.getRuntimeState).toHaveBeenCalledTimes(1);
  });

  it("does not re-render when later polls return an equal snapshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      let renders = 0;
      renderHook(() => {
        renders += 1;
        return useVoiceModelStatus({ enabled: true });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const afterFirstPoll = renders;
      // Idle cadence is 10 s: polls at 0 s, 10 s and 20 s; the equal snapshots must not re-render.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(21_000);
      });
      expect(mocks.service!.getRuntimeState.mock.calls.length).toBe(3);
      expect(renders).toBe(afterFirstPoll);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is none without a selected model", async () => {
    mocks.settings = { voiceDictation: {} };
    const { result } = renderHook(() => useVoiceModelStatus({ enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBe("none");
  });
});
