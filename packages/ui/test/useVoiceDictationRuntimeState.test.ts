// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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

import { useVoiceDictationRuntimeState } from "../src/hooks/useVoiceDictationRuntimeState.js";

describe("useVoiceDictationRuntimeState", () => {
  afterEach(() => cleanup());

  it("gives a re-enabled view the current shared snapshot, not the one it last saw", async () => {
    const observer = renderHook(() => useVoiceDictationRuntimeState());
    const subscriber = renderHook(
      ({ enabled }: { enabled: boolean }) => useVoiceDictationRuntimeState({ enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() =>
      expect(subscriber.result.current.runtimeState.loadedModelId).toBe("model-a"),
    );

    // The subscriber stops listening while the model changes; only the observer sees it.
    subscriber.rerender({ enabled: false });
    h.state.runtime = { loadedModelId: "model-b", activeModelId: null, activePhase: null };
    await waitFor(
      () => expect(observer.result.current.runtimeState.loadedModelId).toBe("model-b"),
      {
        timeout: 3_000,
      },
    );

    // Re-enabling must show model-b at once: later polls equal the shared snapshot and would not notify.
    subscriber.rerender({ enabled: true });
    expect(subscriber.result.current.runtimeState.loadedModelId).toBe("model-b");
  });
});
