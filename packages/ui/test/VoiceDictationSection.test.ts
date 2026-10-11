// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: {
    downloadRequested: boolean;
    downloadPolls: number;
    downloadStatus: "not_downloaded" | "downloading";
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
  return {
    state,
    voiceDictationService: {
      listModels: vi.fn(async () => {
        if (state.downloadRequested) {
          state.downloadPolls += 1;
          if (state.downloadPolls >= 2) state.downloadStatus = "downloading";
        }
        return [
          {
            descriptor,
            state:
              state.downloadStatus === "downloading"
                ? { status: "downloading" as const, downloadedBytes: 0, totalBytes: 10 }
                : { status: "not_downloaded" as const },
          },
        ];
      }),
      downloadModel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            state.downloadRequested = true;
            state.resolveDownload = resolve;
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
  useSettings: () => ({ settings: { voiceDictation: {} }, update: vi.fn(async () => {}) }),
}));
vi.mock("@/hooks/useVoiceDictationRuntimeState.js", () => ({
  useVoiceDictationRuntimeState: () => ({
    runtimeState: { loadedModelId: null, activeModelId: null, idleUnloadAt: null },
    now: Date.now(),
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

import { VoiceDictationSection } from "@/settings/VoiceDictationSection.js";

beforeEach(() => {
  h.state.downloadRequested = false;
  h.state.downloadPolls = 0;
  h.state.downloadStatus = "not_downloaded";
  h.state.resolveDownload = undefined;
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("VoiceDictationSection model downloads", () => {
  it("shows a starting state immediately and keeps polling until download progress appears", async () => {
    render(createElement(VoiceDictationSection, { isDesktop: true }));

    fireEvent.click(await screen.findByRole("button", { name: "voiceDictation.models.download" }));

    expect(
      (
        await screen.findByRole("button", { name: "voiceDictation.models.startingDownload" })
      ).hasAttribute("disabled"),
    ).toBe(true);
    await waitFor(
      () => expect(screen.getByText("voiceDictation.models.downloading")).toBeTruthy(),
      { timeout: 2000 },
    );
    expect(h.voiceDictationService.listModels.mock.calls.length).toBeGreaterThan(2);
    h.state.resolveDownload?.();
  });
});
