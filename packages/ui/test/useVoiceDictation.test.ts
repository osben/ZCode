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
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
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
    expect(onTranscript).toHaveBeenCalledWith("Hello there");
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
    expect(onTranscript).toHaveBeenCalledWith("One shot");
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

    expect(onTranscript).toHaveBeenCalledWith("Hello there");
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
    expect(onTranscript).toHaveBeenCalledWith("Hello there");
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
    expect(onTranscript).toHaveBeenCalledWith("Hello there");
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
