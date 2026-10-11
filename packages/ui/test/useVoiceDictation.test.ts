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
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ voiceDictationService: mocks.service }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: { voiceDictation: { modelId: "model-one", language: "en" } } }),
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
});
