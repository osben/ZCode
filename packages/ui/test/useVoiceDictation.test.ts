// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  service: null as Record<string, ReturnType<typeof vi.fn>> | null,
  recorder: null as {
    options: { onChunk?: (samples: Float32Array) => void; collectSamples?: boolean } | null;
    isRecording: boolean;
    stop: () => Float32Array;
  } | null,
  settings: null as { voiceDictation?: Record<string, unknown> } | null,
  feedbackSound: null as ReturnType<typeof vi.fn> | null,
  platform: { setDictationSystemMute: null as ReturnType<typeof vi.fn> | null },
  openSettings: vi.fn(),
  logger: { warn: vi.fn() },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ voiceDictationService: mocks.service }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => (mocks.platform.setDictationSystemMute ? mocks.platform : null),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useEffectiveShortcutBindings: () => ({ voiceDictation: [] }),
}));
vi.mock("@/shortcuts/bindings.js", () => ({
  isShortcutRecordingActive: () => false,
  matchesShortcutBinding: () => false,
}));
vi.mock("@/lib/voiceDictationShortcut.js", () => ({ isVoiceShortcutReleased: () => false }));
vi.mock("@/hooks/useOpenVoiceDictationSettings.js", () => ({
  useOpenVoiceDictationSettings: () => mocks.openSettings,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({ logger: mocks.logger }));
vi.mock("@/lib/voiceDictationFeedbackSound.js", () => ({
  playVoiceDictationFeedbackSound: (...args: [string, number]) => mocks.feedbackSound!(...args),
}));
vi.mock("@/lib/voiceDictationRecorder.js", () => ({
  VoiceDictationRecorder: class {
    options: { onChunk?: (samples: Float32Array) => void; collectSamples?: boolean } | null = null;
    isRecording = false;
    constructor() {
      mocks.recorder = this;
    }
    async start(options: { onChunk?: (samples: Float32Array) => void; collectSamples?: boolean }) {
      this.options = options;
      this.isRecording = true;
    }
    stop() {
      this.isRecording = false;
      return new Float32Array(this.options?.collectSamples === false ? 0 : 8000);
    }
    cancel() {
      this.isRecording = false;
    }
  },
}));

import { toast } from "@/components/ui/toast.js";
import { DEFAULT_POST_PROCESS_PROMPT } from "@zcode/services";
import { useVoiceDictation } from "@/hooks/useVoiceDictation.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mocks.recorder = null;
  // module-mock 的 vi.fn 跨用例共享；restoreAllMocks 不清空调用历史，先清空再断言。
  vi.mocked(toast).mockClear();
  mocks.settings = { voiceDictation: { modelId: "model-one", language: "en" } };
  mocks.feedbackSound = vi.fn().mockResolvedValue(undefined);
  mocks.platform.setDictationSystemMute = vi.fn().mockResolvedValue(undefined);
  mocks.service = {
    setIdleUnloadMinutes: vi.fn().mockResolvedValue(undefined),
    beginStream: vi.fn().mockResolvedValue("stream-1"),
    feedStream: vi.fn().mockResolvedValue({ committed: "Hello ", tentative: "there" }),
    finalizeStream: vi.fn().mockResolvedValue({ text: "Hello there", language: "en" }),
    cancelStream: vi.fn().mockResolvedValue(undefined),
    transcribe: vi.fn().mockResolvedValue({ text: "One shot", language: "en" }),
  };
});

describe("useVoiceDictation streaming", () => {
  it("keeps partial text as preview and inserts only the finalized transcript once", async () => {
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    expect(mocks.recorder?.options?.collectSamples).toBe(false);
    await act(async () => mocks.recorder?.options?.onChunk?.(new Float32Array([0.5, 0.25])));
    await waitFor(() =>
      expect(hook.result.current.preview).toEqual({ committed: "Hello ", tentative: "there" }),
    );
    expect(onTranscript).not.toHaveBeenCalled();

    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());

    expect(mocks.service?.finalizeStream).toHaveBeenCalledWith("stream-1");
    expect(mocks.service?.transcribe).not.toHaveBeenCalled();
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
    expect(hook.result.current.preview).toBeNull();
  });

  it("uses the one-shot path when the loaded runtime declines streaming", async () => {
    mocks.service!.beginStream!.mockResolvedValue(null);
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());

    expect(mocks.service?.feedStream).not.toHaveBeenCalled();
    expect(mocks.service?.finalizeStream).not.toHaveBeenCalled();
    expect(mocks.service?.transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("One shot", "One shot");
  });

  it("continues dictation when an older host lacks the idle unload setting", async () => {
    mocks.service!.setIdleUnloadMinutes!.mockRejectedValue(
      new Error("Method not found: setIdleUnloadMinutes"),
    );
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    expect(mocks.service?.beginStream).toHaveBeenCalledWith({
      modelId: "model-one",
      language: "en",
    });
    expect(mocks.recorder?.isRecording).toBe(true);

    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());

    expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
  });

  it("does not ignore unrelated idle unload setting failures", async () => {
    mocks.service!.setIdleUnloadMinutes!.mockRejectedValue(new Error("Host disconnected"));
    const onTranscript = vi.fn();
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());

    expect(mocks.service?.beginStream).not.toHaveBeenCalled();
    expect(mocks.recorder?.isRecording).toBe(false);
    expect(hook.result.current.phase).toBe("idle");
  });

  it("merges backlogged chunks when feed RPC is slower than the mic instead of failing the stream", async () => {
    let pendingFeed = 0;
    const feedPayloads: number[] = [];
    mocks.service!.feedStream!.mockImplementation(async (_streamId: string, pcm: Uint8Array) => {
      feedPayloads.push(pcm.byteLength);
      pendingFeed += 1;
      // 模拟 RPC 慢于送块：在前几次 feed 完成前继续压入新块。
      if (pendingFeed <= 2) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return { committed: "Hello ", tentative: "there" };
    });
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        mocks.recorder?.options?.onChunk?.(new Float32Array(100).fill(0.5));
      });
    }
    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());

    // 慢 RPC 只应造成积压合并，而不是终止听写：无失败提示，全部采样按序送达，最终转写成功。
    expect(toast).not.toHaveBeenCalled();
    expect(feedPayloads.reduce((sum, bytes) => sum + bytes, 0)).toBe(8 * 100 * 2);
    expect(mocks.service?.finalizeStream).toHaveBeenCalledWith("stream-1");
    expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
  });

  it("fails the stream when the pending PCM backlog exceeds its bound", async () => {
    // Первый feed зависает — имитируем надолго stalled Host, чтобы backlog копился.
    let resolveFeed: (() => void) | null = null;
    mocks.service!.feedStream!.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFeed = () => resolve({ committed: "", tentative: "" });
        }),
    );
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    await act(async () => mocks.recorder?.options?.onChunk?.(new Float32Array(100)));
    // Первый чанк уходит в зависший feed; следующий переваливает границу лимита —
    // ожидаем явный отказ вместо бесконечного накопления.
    await act(async () => mocks.recorder?.options?.onChunk?.(new Float32Array(16000 * 30 + 1)));

    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    expect(toast).toHaveBeenCalledWith("voiceDictation.transcribeFailed");
    expect(mocks.service?.cancelStream).toHaveBeenCalledWith("stream-1");

    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());
    expect(mocks.service?.finalizeStream).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    resolveFeed?.();
  });

  it("cancels the stream on window blur without inserting its preview", async () => {
    const onTranscript = vi.fn();
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    act(() => window.dispatchEvent(new Event("blur")));
    await waitFor(() => expect(mocks.service?.cancelStream).toHaveBeenCalledWith("stream-1"));

    expect(onTranscript).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("idle");
  });

  it("does not insert a final result after the composer unmounts during finalization", async () => {
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let resolveFinalize!: (result: { text: string; language: string }) => void;
    mocks.service!.finalizeStream!.mockImplementation(
      () => new Promise((resolve) => (resolveFinalize = resolve)),
    );
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    now.mockReturnValue(1500);
    const stopping = hook.result.current.stop();
    await waitFor(() => expect(mocks.service?.finalizeStream).toHaveBeenCalled());
    hook.unmount();
    resolveFinalize({ text: "Hello there", language: "en" });
    await act(async () => stopping);

    expect(mocks.service?.cancelStream).toHaveBeenCalledWith("stream-1");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("plays chimes around the system mute in spec order when enabled", async () => {
    // Spec ordering: start chime → mute applies → … → mute released → stop chime.
    mocks.settings!.voiceDictation = {
      modelId: "model-one",
      language: "en",
      feedbackSounds: true,
      feedbackVolume: 40,
      muteWhileRecording: true,
    };
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    await waitFor(() => expect(mocks.platform.setDictationSystemMute).toHaveBeenCalledWith(true));

    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());
    await waitFor(() => expect(mocks.feedbackSound).toHaveBeenCalledTimes(2));

    const mute = mocks.platform.setDictationSystemMute!;
    const chime = mocks.feedbackSound!;
    expect(chime.mock.calls).toEqual([
      ["start", 40],
      ["stop", 40],
    ]);
    expect(mute.mock.calls).toEqual([[true], [false]]);
    expect(chime.mock.invocationCallOrder[0]).toBeLessThan(mute.mock.invocationCallOrder[0]);
    expect(mute.mock.invocationCallOrder[0]).toBeLessThan(mute.mock.invocationCallOrder[1]);
    expect(mute.mock.invocationCallOrder[1]).toBeLessThan(chime.mock.invocationCallOrder[1]);
  });

  it("stays silent for sounds and the mute when the settings are off", async () => {
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());

    expect(mocks.feedbackSound).not.toHaveBeenCalled();
    expect(mocks.platform.setDictationSystemMute).not.toHaveBeenCalled();
    expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
  });

  it("does not apply a pending mute after the recording already ended", async () => {
    mocks.settings!.voiceDictation = {
      modelId: "model-one",
      language: "en",
      feedbackSounds: true,
      feedbackVolume: 40,
      muteWhileRecording: true,
    };
    // The start chime is still playing when the user releases: the queued mute apply must be
    // dropped instead of muting a recording that no longer exists (stuck output mute).
    let resolveChime!: () => void;
    mocks.feedbackSound!.mockImplementation(
      () => new Promise<void>((resolve) => (resolveChime = resolve)),
    );
    const onTranscript = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    now.mockReturnValue(1500);
    await act(async () => hook.result.current.stop());
    await act(async () => {
      resolveChime();
    });
    // Let the chained (dropped) apply and any follow-up settle.
    await act(async () => {});

    expect(mocks.platform.setDictationSystemMute).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("idle");
  });
});

describe("useVoiceDictation cancel and notices", () => {
  const escapeEvent = () =>
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

  it("cancels recording on Escape without inserting, chiming, or reaching later Escape handlers", async () => {
    mocks.settings!.voiceDictation = {
      modelId: "model-one",
      language: "en",
      feedbackSounds: true,
      muteWhileRecording: true,
    };
    const onTranscript = vi.fn();
    const laterHandler = vi.fn();
    window.addEventListener("keydown", laterHandler);
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    await waitFor(() => expect(hook.result.current.phase).toBe("recording"));
    const event = escapeEvent();
    act(() => {
      document.body.dispatchEvent(event);
    });
    await waitFor(() => expect(mocks.service?.cancelStream).toHaveBeenCalledWith("stream-1"));
    window.removeEventListener("keydown", laterHandler);

    expect(event.defaultPrevented).toBe(true);
    expect(laterHandler).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(mocks.service?.finalizeStream).not.toHaveBeenCalled();
    expect(mocks.feedbackSound).not.toHaveBeenCalledWith("stop", expect.anything());
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.preview).toBeNull();
  });

  it("leaves Escape alone while idle so the agent stop shortcut keeps working", () => {
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript: vi.fn(), scopeRef: { current: null } }),
    );
    const event = escapeEvent();
    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(hook.result.current.phase).toBe("idle");
  });

  it("exposes cancel() for the feedback panel button", async () => {
    const onTranscript = vi.fn();
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    act(() => hook.result.current.cancel());
    await waitFor(() => expect(mocks.service?.cancelStream).toHaveBeenCalledWith("stream-1"));

    expect(hook.result.current.phase).toBe("idle");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("tells the user when a recording was too short to transcribe", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const onTranscript = vi.fn();
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());
    now.mockReturnValue(1100);
    await act(async () => hook.result.current.stop());

    expect(toast).toHaveBeenCalledWith("voiceDictation.tooShort");
    expect(onTranscript).not.toHaveBeenCalled();
    expect(mocks.service?.finalizeStream).not.toHaveBeenCalled();
  });

  it("explains a release during model loading instead of calling the hold too short", async () => {
    let resolveBegin!: (id: string) => void;
    mocks.service!.beginStream!.mockImplementation(
      () => new Promise<string>((resolve) => (resolveBegin = resolve)),
    );
    const onTranscript = vi.fn();
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

    let starting!: Promise<void>;
    let stopping!: Promise<void>;
    act(() => {
      starting = hook.result.current.start();
    });
    expect(hook.result.current.phase).toBe("loading");
    act(() => {
      stopping = hook.result.current.stop();
    });
    await waitFor(() => expect(mocks.service?.beginStream).toHaveBeenCalled());
    await act(async () => {
      resolveBegin("stream-1");
      await starting;
      await stopping;
    });

    expect(toast).toHaveBeenCalledWith("voiceDictation.stillLoading");
    expect(toast).not.toHaveBeenCalledWith("voiceDictation.tooShort");
    expect(mocks.service?.finalizeStream).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("idle");
  });

  it("offers to open settings when no model is selected", async () => {
    mocks.settings = { voiceDictation: {} };
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript: vi.fn(), scopeRef: { current: null } }),
    );

    await act(async () => hook.result.current.start());

    expect(toast).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast).mock.calls[0]!;
    expect(message).toBe("voiceDictation.noModelSelected");
    expect(options).toMatchObject({ actionLabel: "voiceDictation.openSettings" });
    options?.onAction?.();
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.service?.beginStream).not.toHaveBeenCalled();
  });
});

describe("useVoiceDictation languages", () => {
  const beginWith = async (voiceDictation: Record<string, unknown>) => {
    mocks.settings = { voiceDictation: { modelId: "model-one", ...voiceDictation } };
    const hook = renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript: vi.fn(), scopeRef: { current: null } }),
    );
    await act(async () => hook.result.current.start());
    return mocks.service!.beginStream!.mock.calls.at(-1)![0];
  };

  it("forces a single selected language, and prefers languages over the legacy field", async () => {
    expect(await beginWith({ languages: ["uk"], language: "en" })).toEqual({
      modelId: "model-one",
      language: "uk",
    });
  });

  it("leaves detection to the model for several or no selected languages", async () => {
    expect((await beginWith({ languages: ["uk", "en"] })).language).toBe("auto");
    expect((await beginWith({ languages: [], language: "en" })).language).toBe("auto");
  });
});

describe("useVoiceDictation post-processing", () => {
  const speak = async (hook: { result: { current: ReturnType<typeof useVoiceDictation> } }) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    await act(async () => hook.result.current.start());
    now.mockReturnValue(1500);
  };
  const renderDictation = (onTranscript = vi.fn()) =>
    renderHook(() =>
      useVoiceDictation({ enabled: true, onTranscript, scopeRef: { current: null } }),
    );

  beforeEach(() => {
    mocks.service!.postProcess = vi.fn().mockResolvedValue({ text: "Hello there." });
    mocks.settings = {
      voiceDictation: { modelId: "model-one", language: "en", postProcessEnabled: true },
    };
  });

  it("inserts the processed text and hands the raw transcript over for the clipboard", async () => {
    let finish!: (value: { text: string }) => void;
    mocks.service!.postProcess!.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const onTranscript = vi.fn();
    const hook = renderDictation(onTranscript);
    await speak(hook);

    let stopping!: Promise<void>;
    act(() => {
      stopping = hook.result.current.stop();
    });
    await waitFor(() => expect(hook.result.current.phase).toBe("processing"));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(mocks.service!.postProcess).toHaveBeenCalledWith({
      text: "Hello there",
      prompt: DEFAULT_POST_PROCESS_PROMPT,
      provider: "apple-fm",
    });

    await act(async () => {
      finish({ text: "Hello there." });
      await stopping;
    });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("Hello there.", "Hello there");
    expect(hook.result.current.phase).toBe("idle");
  });

  it("uses the user's prompt and provider", async () => {
    mocks.settings = {
      voiceDictation: {
        modelId: "model-one",
        postProcessEnabled: true,
        postProcessPrompt: "Shorten: {{text}}",
        postProcessProvider: "apple-fm",
      },
    };
    const hook = renderDictation();
    await speak(hook);
    await act(async () => hook.result.current.stop());

    expect(mocks.service!.postProcess).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Shorten: {{text}}" }),
    );
  });

  it("does not call the provider when post-processing is off", async () => {
    mocks.settings = { voiceDictation: { modelId: "model-one", language: "en" } };
    const onTranscript = vi.fn();
    const hook = renderDictation(onTranscript);
    await speak(hook);
    await act(async () => hook.result.current.stop());

    expect(mocks.service!.postProcess).not.toHaveBeenCalled();
    expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
  });

  it("falls back to the raw transcript, logging the failure without an error toast", async () => {
    mocks.service!.postProcess!.mockRejectedValue(new Error("post-processing failed: timeout"));
    const onTranscript = vi.fn();
    const hook = renderDictation(onTranscript);
    await speak(hook);
    await act(async () => hook.result.current.stop());

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
    expect(toast).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "voice dictation post-processing failed; inserting the raw transcript",
      expect.objectContaining({ error: "post-processing failed: timeout" }),
    );
  });

  it("falls back to the raw transcript when an older Host has no post-processing method", async () => {
    delete mocks.service!.postProcess;
    const onTranscript = vi.fn();
    const hook = renderDictation(onTranscript);
    await speak(hook);
    await act(async () => hook.result.current.stop());

    expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
  });

  it("gives up on a stuck provider after the client timeout and inserts the raw transcript", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mocks.service!.postProcess!.mockImplementation(() => new Promise(() => undefined));
      const onTranscript = vi.fn();
      const hook = renderDictation(onTranscript);
      await speak(hook);
      let stopping!: Promise<void>;
      act(() => {
        stopping = hook.result.current.stop();
      });
      await vi.advanceTimersByTimeAsync(20_001);
      await act(async () => stopping);

      expect(onTranscript).toHaveBeenCalledWith("Hello there", "Hello there");
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards the result when Escape cancels during processing", async () => {
    let resolveProcess!: (value: { text: string }) => void;
    mocks.service!.postProcess!.mockImplementation(
      () => new Promise((resolve) => (resolveProcess = resolve)),
    );
    const onTranscript = vi.fn();
    const hook = renderDictation(onTranscript);
    await speak(hook);
    let stopping!: Promise<void>;
    act(() => {
      stopping = hook.result.current.stop();
    });
    await waitFor(() => expect(hook.result.current.phase).toBe("processing"));

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(hook.result.current.phase).toBe("idle");

    await act(async () => {
      resolveProcess({ text: "Hello there." });
      await stopping;
    });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("idle");
  });
});
