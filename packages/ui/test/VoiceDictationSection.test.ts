// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: {
    downloadRequested: boolean;
    downloadPolls: number;
    downloadStatus: "not_downloaded" | "downloading" | "ready";
    resolveDownload?: () => void;
  } = {
    downloadRequested: false,
    downloadPolls: 0,
    downloadStatus: "not_downloaded",
  };
  const descriptor = {
    id: "model-one",
    name: "Model One",
    description: "Test model",
    family: "whisper",
    languageCount: 1,
    streaming: false,
    license: "mit",
    huggingFaceRepo: "owner/model-one",
    revision: "abc123",
    fileName: "model-one.gguf",
    sizeBytes: 10,
    sha256: "test",
  };
  const secondDescriptor = { ...descriptor, id: "model-two", name: "Model Two" };
  const updateSettings = vi.fn(async () => {});
  return {
    state,
    updateSettings,
    settings: { voiceDictation: { modelId: "model-one" } as Record<string, unknown> },
    voiceDictationService: {
      listModels: vi.fn(async () => {
        if (state.downloadRequested) {
          state.downloadPolls += 1;
          if (state.downloadPolls >= 2) state.downloadStatus = "downloading";
        }
        return [
          {
            descriptor,
            state: {
              status: "ready" as const,
              path: "/models/model-one.gguf",
              sizeBytes: 10,
              source: "zcode" as const,
            },
          },
          {
            descriptor: secondDescriptor,
            state:
              state.downloadStatus === "downloading"
                ? { status: "downloading" as const, downloadedBytes: 0, totalBytes: 10 }
                : state.downloadStatus === "ready"
                  ? {
                      status: "ready" as const,
                      path: "/models/model-two.gguf",
                      sizeBytes: 10,
                      source: "zcode" as const,
                    }
                  : { status: "not_downloaded" as const },
          },
        ];
      }),
      setIdleUnloadMinutes: vi.fn(async () => {}),
      downloadModel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            state.downloadRequested = true;
            state.resolveDownload = () => {
              state.downloadStatus = "ready";
              resolve();
            };
          }),
      ),
      cancelDownload: vi.fn(async () => {}),
      removeModel: vi.fn(async () => {}),
    },
  };
});

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ voiceDictationService: h.voiceDictationService }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: h.settings,
    update: h.updateSettings,
  }),
}));
vi.mock("@/hooks/useVoiceDictationRuntimeState.js", () => ({
  useVoiceDictationRuntimeState: () => ({
    runtimeState: { loadedModelId: null, activeModelId: null, activePhase: null },
  }),
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => "Cmd+Shift+D",
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/lib/voiceDictationFeedbackSound.js", () => ({
  playVoiceDictationFeedbackSound: vi.fn(async () => {}),
}));
const recorderMocks = vi.hoisted(() => ({
  instances: [] as {
    isRecording: boolean;
    cancelCount: number;
    stopCount: number;
    resolveStart?: () => void;
  }[],
}));
// Заменяем рекордер целиком: существующие тесты используют только список устройств,
// а новые проверяют отмену mic-теста при уходе со страницы в ожидании разрешения.
vi.mock("@/lib/voiceDictationRecorder.js", () => ({
  listAudioInputDevices: vi.fn(async () => []),
  VoiceDictationRecorder: class {
    options: unknown = null;
    isRecording = false;
    cancelCount = 0;
    stopCount = 0;
    resolveStart?: () => void;
    constructor() {
      recorderMocks.instances.push(this);
    }
    async start(options: unknown) {
      this.options = options;
      this.isRecording = true;
      // Имитируем висящий запрос разрешения микрофона.
      await new Promise<void>((resolve) => {
        this.resolveStart = resolve;
      });
    }
    stop() {
      this.stopCount += 1;
      this.isRecording = false;
      return new Float32Array(0);
    }
    cancel() {
      this.cancelCount += 1;
      this.isRecording = false;
      this.resolveStart?.();
    }
  },
}));

import { toast } from "@/components/ui/toast.js";
import { playVoiceDictationFeedbackSound } from "@/lib/voiceDictationFeedbackSound.js";
import { VoiceDictationSection } from "@/settings/VoiceDictationSection.js";

// Radix Slider (volume row) reads element sizes through ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;

beforeEach(() => {
  h.state.downloadRequested = false;
  h.state.downloadPolls = 0;
  h.state.downloadStatus = "not_downloaded";
  h.state.resolveDownload = undefined;
  h.settings.voiceDictation = { modelId: "model-one" };
  recorderMocks.instances.length = 0;
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("VoiceDictationSection model downloads", () => {
  it("persists and applies the selected idle-unload delay", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    fireEvent.click(
      await screen.findByRole("combobox", {
        name: "voiceDictation.models.unloadDelay.title",
      }),
    );
    const option = (await screen.findAllByRole("option"))[2];
    expect(option).toBeTruthy();
    fireEvent.click(option!);

    await waitFor(() =>
      expect(h.updateSettings).toHaveBeenCalledWith({
        voiceDictation: { modelId: "model-one", idleUnloadMinutes: 10 },
      }),
    );
    expect(h.voiceDictationService.setIdleUnloadMinutes).toHaveBeenCalledWith(10);
  });

  it("selects a ready model when its card is clicked", async () => {
    h.state.downloadStatus = "ready";
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Model Two: voiceDictation.models.use" }),
    );

    await waitFor(() =>
      expect(h.updateSettings).toHaveBeenCalledWith({
        voiceDictation: { modelId: "model-two" },
      }),
    );
  });

  it("shows a starting state immediately and keeps polling until download progress appears", async () => {
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Model Two: voiceDictation.models.download" }),
    );

    expect(
      await screen.findByRole("progressbar", {
        name: "voiceDictation.models.startingDownload",
      }),
    ).toBeTruthy();
    expect(screen.getByText("voiceDictation.models.startingDownload")).toBeTruthy();
    await waitFor(
      () => expect(screen.getByText("voiceDictation.models.downloading")).toBeTruthy(),
      { timeout: 2000 },
    );
    expect(h.voiceDictationService.listModels.mock.calls.length).toBeGreaterThan(2);
    h.state.resolveDownload?.();
  });

  it("keeps the ready model selected until the requested download finishes", async () => {
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    expect(await screen.findByText("voiceDictation.models.selected")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Model Two: voiceDictation.models.download" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Model Two: voiceDictation.models.useWhenReady" }),
    );

    expect(screen.getByText("voiceDictation.models.selected")).toBeTruthy();
    expect(screen.getByText("voiceDictation.models.willUseWhenReady")).toBeTruthy();
    expect(screen.queryByText("voiceDictation.models.useWhenReady")).toBeNull();
    expect(h.updateSettings).not.toHaveBeenCalled();
    await screen.findByText("voiceDictation.models.downloading", {}, { timeout: 3000 });

    await act(async () => h.state.resolveDownload?.());
    await waitFor(() =>
      expect(h.updateSettings).toHaveBeenCalledWith({
        voiceDictation: { modelId: "model-two" },
      }),
    );
  });

  it("merges rapid settings edits so the later write keeps the earlier one", async () => {
    h.state.downloadStatus = "ready";
    render(createElement(VoiceDictationSection, { isDesktop: true }));
    await screen.findByText("voiceDictation.models.selected");

    // Две правки подряд без ожидания перерисовки: вторая должна слиться с первой,
    // а не записать voiceDictation целиком от старого снапшота.
    fireEvent.click(
      await screen.findByRole("button", { name: "Model Two: voiceDictation.models.use" }),
    );
    fireEvent.click(
      await screen.findByRole("combobox", { name: "voiceDictation.models.unloadDelay.title" }),
    );
    const option = (await screen.findAllByRole("option"))[2];
    fireEvent.click(option!);

    await waitFor(() => expect(h.updateSettings).toHaveBeenCalledTimes(2));
    expect(h.updateSettings).toHaveBeenLastCalledWith({
      voiceDictation: { modelId: "model-two", idleUnloadMinutes: 10 },
    });
  });

  it("reports a failed download cancellation and still refreshes models", async () => {
    render(createElement(VoiceDictationSection, { isDesktop: true }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Model Two: voiceDictation.models.download" }),
    );
    await screen.findByText("voiceDictation.models.downloading", {}, { timeout: 3000 });

    h.voiceDictationService.cancelDownload.mockRejectedValueOnce(new Error("host busy"));
    fireEvent.click(await screen.findByRole("button", { name: "voiceDictation.models.cancel" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("voiceDictation.cancelDownloadFailed"));
    // finally-ветка должна обновить список даже при неудачной отмене.
    await waitFor(() =>
      expect(h.voiceDictationService.listModels.mock.calls.length).toBeGreaterThan(1),
    );
  });
});

describe("VoiceDictationSection mic test", () => {
  it("cancels capture when the section closes while microphone permission is pending", async () => {
    const { unmount } = render(createElement(VoiceDictationSection, { isDesktop: true }));
    fireEvent.click(await screen.findByRole("button", { name: "voiceDictation.micTest.button" }));
    const recorder = recorderMocks.instances[0];
    expect(recorder?.isRecording).toBe(true);

    // Уход со страницы в момент висящего запроса разрешения: cleanup отменяет и
    // обнуляет ссылку, а компонент после разрешения start() сразу гасит запись.
    unmount();
    await act(async () => {});

    expect(recorder?.cancelCount).toBe(2);
    expect(recorder?.stopCount).toBe(0);
    expect(recorder?.isRecording).toBe(false);
  });
});

describe("VoiceDictationSection feedback sounds", () => {
  it("persists the sound and mute toggles and shows the saved volume", async () => {
    h.settings.voiceDictation = { modelId: "model-one", feedbackVolume: 54 };
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    const slider = await screen.findByRole("slider", {
      name: "voiceDictation.feedbackVolume.title",
    });
    expect(slider.getAttribute("aria-valuenow")).toBe("54");
    expect(screen.getByText("54%")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "voiceDictation.feedback.title" }));
    await waitFor(() =>
      expect(h.updateSettings).toHaveBeenCalledWith({
        voiceDictation: { modelId: "model-one", feedbackVolume: 54, feedbackSounds: true },
      }),
    );

    fireEvent.click(
      screen.getByRole("switch", { name: "voiceDictation.muteWhileRecording.title" }),
    );
    // patchVoice merges with the latest snapshot, so the earlier feedbackSounds edit survives.
    await waitFor(() =>
      expect(h.updateSettings).toHaveBeenLastCalledWith({
        voiceDictation: {
          modelId: "model-one",
          feedbackVolume: 54,
          feedbackSounds: true,
          muteWhileRecording: true,
        },
      }),
    );
  });

  it("previews both chimes at the saved volume from the test button", async () => {
    h.settings.voiceDictation = { modelId: "model-one", feedbackVolume: 30 };
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    fireEvent.click(
      await screen.findByRole("button", { name: "voiceDictation.feedbackVolume.test" }),
    );

    await waitFor(() => expect(playVoiceDictationFeedbackSound).toHaveBeenCalledTimes(2));
    expect(vi.mocked(playVoiceDictationFeedbackSound).mock.calls).toEqual([
      ["start", 30],
      ["stop", 30],
    ]);
  });

  it("persists the volume on commit after a keyboard change", async () => {
    h.settings.voiceDictation = { modelId: "model-one", feedbackVolume: 50 };
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    const slider = await screen.findByRole("slider", {
      name: "voiceDictation.feedbackVolume.title",
    });
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });

    await waitFor(() => {
      expect(h.updateSettings).toHaveBeenCalledWith({
        voiceDictation: { modelId: "model-one", feedbackVolume: 51 },
      });
    });
  });
});
