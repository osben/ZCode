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

import { useVoiceDictation } from "@/hooks/useVoiceDictation.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mocks.recorder = null;
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
