// @vitest-environment jsdom

import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  service: null as Record<string, ReturnType<typeof vi.fn>> | null,
  settings: null as { voiceDictation?: Record<string, unknown> } | null,
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ voiceDictationService: mocks.service }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: mocks.warn, info: mocks.info } }));

import { useVoiceModelWarmUp } from "@/hooks/useVoiceModelWarmUp.js";

let scope: HTMLDivElement;
let input: HTMLInputElement;

beforeEach(() => {
  scope = document.createElement("div");
  input = document.createElement("input");
  scope.append(input);
  document.body.append(scope);
  mocks.settings = { voiceDictation: { modelId: "model-one", idleUnloadMinutes: 10 } };
  mocks.service = {
    setIdleUnloadMinutes: vi.fn().mockResolvedValue(undefined),
    warmUp: vi.fn().mockResolvedValue(undefined),
  };
  mocks.warn.mockClear();
  mocks.info.mockClear();
});

afterEach(() => {
  cleanup();
  scope.remove();
  vi.useRealTimers();
});

const render = (enabled = true) =>
  renderHook(() => useVoiceModelWarmUp({ enabled, scopeRef: { current: scope } }));
const focusComposer = () => fireEvent.focusIn(input);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useVoiceModelWarmUp", () => {
  it("warms the selected model when focus enters the composer, applying the idle preference first", async () => {
    render();
    focusComposer();
    await flush();

    expect(mocks.service!.setIdleUnloadMinutes).toHaveBeenCalledWith(10);
    expect(mocks.service!.warmUp).toHaveBeenCalledWith({ modelId: "model-one" });
    expect(mocks.service!.setIdleUnloadMinutes!.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.service!.warmUp!.mock.invocationCallOrder[0],
    );
  });

  it("warms immediately when the composer already holds focus on mount", async () => {
    input.focus();
    render();
    await flush();
    expect(mocks.service!.warmUp).toHaveBeenCalledTimes(1);
  });

  it("is on by default and off only when warmUpOnFocus is explicitly false", async () => {
    mocks.settings = { voiceDictation: { modelId: "model-one", warmUpOnFocus: false } };
    render();
    focusComposer();
    await flush();
    expect(mocks.service!.warmUp).not.toHaveBeenCalled();
  });

  it("does nothing when disabled, without a service, or without a selected model", async () => {
    const disabledWarmUp = mocks.service!.warmUp!;
    render(false);
    focusComposer();
    await flush();
    expect(disabledWarmUp).not.toHaveBeenCalled();
    cleanup();

    mocks.service = null;
    expect(() => {
      render();
      focusComposer();
    }).not.toThrow();
    cleanup();

    mocks.service = { setIdleUnloadMinutes: vi.fn(), warmUp: vi.fn() };
    mocks.settings = { voiceDictation: {} };
    render();
    focusComposer();
    await flush();
    expect(mocks.service.warmUp).not.toHaveBeenCalled();
  });

  it("requests at most once per model within 30 seconds and not while one is in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    let finish!: () => void;
    mocks.service!.warmUp!.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    render();

    focusComposer();
    focusComposer();
    await flush();
    expect(mocks.service!.warmUp).toHaveBeenCalledTimes(1);
    finish();
    await flush();

    vi.setSystemTime(1_000_000 + 29_000);
    focusComposer();
    await flush();
    expect(mocks.service!.warmUp).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 31_000);
    focusComposer();
    await flush();
    expect(mocks.service!.warmUp).toHaveBeenCalledTimes(2);
  });

  it("warms again right away when the selected model changes", async () => {
    const hook = renderHook(
      ({ id }) => {
        mocks.settings = { voiceDictation: { modelId: id } };
        return useVoiceModelWarmUp({ enabled: true, scopeRef: { current: scope } });
      },
      { initialProps: { id: "model-one" } },
    );
    focusComposer();
    await flush();
    hook.rerender({ id: "model-two" });
    focusComposer();
    await flush();

    expect(mocks.service!.warmUp).toHaveBeenNthCalledWith(1, { modelId: "model-one" });
    expect(mocks.service!.warmUp).toHaveBeenNthCalledWith(2, { modelId: "model-two" });
  });

  it("only logs a failed warm-up and keeps working", async () => {
    mocks.service!.warmUp!.mockRejectedValue(new Error("model file missing"));
    render();
    focusComposer();
    await flush();

    expect(mocks.warn).toHaveBeenCalledWith(
      "voice model warm-up failed",
      expect.objectContaining({ error: "model file missing" }),
    );
  });

  it("stops asking after an older Host reports the method missing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    mocks.service!.warmUp!.mockRejectedValue(new Error("Method not found: warmUp"));
    render();
    focusComposer();
    await flush();
    vi.setSystemTime(2_000_000 + 120_000);
    focusComposer();
    await flush();

    expect(mocks.service!.warmUp).toHaveBeenCalledTimes(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("tolerates an older Host without the idle preference method", async () => {
    mocks.service!.setIdleUnloadMinutes!.mockRejectedValue(
      new Error("Method not found: setIdleUnloadMinutes"),
    );
    render();
    focusComposer();
    await flush();
    expect(mocks.service!.warmUp).toHaveBeenCalledWith({ modelId: "model-one" });
  });
});
