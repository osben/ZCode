// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictationRuntimeState, VoiceModelListItem } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import ukUA from "@/i18n/locales/uk-UA.js";
import { formatVoiceModelDownloadSpeed, VoiceModelRow } from "@/settings/VoiceDictationModelRow.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const firstModel: VoiceModelListItem = {
  descriptor: {
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
  },
  state: { status: "ready", path: "/models/model-one.gguf", sizeBytes: 10, source: "zcode" },
};

const secondModel: VoiceModelListItem = {
  ...firstModel,
  descriptor: { ...firstModel.descriptor, id: "model-two", name: "Model Two" },
  state: { status: "ready", path: "/models/model-two.gguf", sizeBytes: 10, source: "zcode" },
};

function renderRows(runtimeState: VoiceDictationRuntimeState) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        "div",
        null,
        createElement(VoiceModelRow, {
          item: firstModel,
          selected: true,
          runtimeState,
          onSelect: () => undefined,
          onUseWhenReady: () => undefined,
          onDownload: () => undefined,
          onCancel: () => undefined,
          onRemove: () => undefined,
        }),
        createElement(VoiceModelRow, {
          item: secondModel,
          selected: false,
          runtimeState,
          onSelect: () => undefined,
          onUseWhenReady: () => undefined,
          onDownload: () => undefined,
          onCancel: () => undefined,
          onRemove: () => undefined,
        }),
      ),
    ),
  );
}

function renderSingleRow(onRemove: () => void) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(VoiceModelRow, {
        item: firstModel,
        selected: true,
        runtimeState: { loadedModelId: null, activeModelId: null, activePhase: null },
        onSelect: () => undefined,
        onUseWhenReady: () => undefined,
        onDownload: () => undefined,
        onCancel: () => undefined,
        onRemove,
      }),
    ),
  );
}

function renderDownloadingRow(downloadedBytes: number, totalBytes = 1000, onCancel = vi.fn()) {
  const createRow = (bytes: number) =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(VoiceModelRow, {
        item: {
          ...firstModel,
          state: { status: "downloading", downloadedBytes: bytes, totalBytes },
        },
        selected: false,
        runtimeState: { loadedModelId: null, activeModelId: null, activePhase: null },
        pendingUse: true,
        onSelect: () => undefined,
        onUseWhenReady: () => undefined,
        onDownload: () => undefined,
        onCancel,
        onRemove: () => undefined,
      }),
    );
  const view = render(createRow(downloadedBytes));
  return {
    onCancel,
    ...view,
    rerenderProgress: (bytes: number) => view.rerender(createRow(bytes)),
  };
}

describe("VoiceModelRow runtime status", () => {
  it("keeps the selected model distinct from the loaded model without an unload countdown", () => {
    renderRows({ loadedModelId: "model-two", activeModelId: null, activePhase: null });

    const activeBadge = screen.getByText("Active");
    expect(activeBadge).toBeTruthy();
    expect(activeBadge.className).toContain("bg-surface");
    expect(screen.getByText("Loaded in memory")).toBeTruthy();
    expect(screen.queryByText(/unloads in/)).toBeNull();
  });

  it("renders separate cards and highlights the selected model", () => {
    const view = renderRows({ loadedModelId: null, activeModelId: null, activePhase: null });
    const cards = view.container.querySelectorAll("article[data-selected]");
    const selectedCard = view.container.querySelector('article[data-selected="true"]');

    expect(cards).toHaveLength(2);
    expect(selectedCard?.className).toContain("bg-card-selected");
    expect(selectedCard?.className).toContain("border-brand/40");
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getAllByText("Test model")).toHaveLength(2);
    expect(screen.getAllByText("1 languages")).toHaveLength(2);
    expect(screen.getAllByText("License: mit")).toHaveLength(2);
  });

  it("shows when the loaded model is transcribing without an idle countdown", () => {
    renderRows({
      loadedModelId: "model-one",
      activeModelId: "model-one",
      activePhase: "transcribing",
    });

    expect(screen.getByText("Transcribing")).toBeTruthy();
    expect(screen.queryByText(/unloads in/)).toBeNull();
  });

  it("shows active streaming transcription distinctly", () => {
    renderRows({
      loadedModelId: "model-one",
      activeModelId: "model-one",
      activePhase: "streaming",
    });

    expect(screen.getByText("Streaming transcription")).toBeTruthy();
    expect(screen.queryByText(/unloads in/)).toBeNull();
  });
});

describe("VoiceModelRow model actions", () => {
  it("places the progress bar above status and cancel, and displays the measured rate", () => {
    const view = renderDownloadingRow(100);
    const progress = screen.getByRole("progressbar", { name: "Downloading 10%" });
    const status = screen.getByText("Downloading 10%");
    const cancel = screen.getByRole("button", { name: "Cancel" });

    expect(progress.getAttribute("aria-valuenow")).toBe("10");
    expect(
      progress.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(status.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Will use when ready")).toBeTruthy();
    expect(formatVoiceModelDownloadSpeed(26_000_000)).toBe("26.0 MB/s");
    expect(formatVoiceModelDownloadSpeed(26_000)).toBe("26 KB/s");
    expect(
      view.container.querySelector("[data-testid='voice-model-download-progress']"),
    ).toBeTruthy();
  });

  it("shows download speed derived from progress updates", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const view = renderDownloadingRow(0, 30_000_000);

    now.mockReturnValue(2000);
    view.rerenderProgress(26_000_000);

    expect(screen.getByText("26.0 MB/s")).toBeTruthy();
  });

  it("asks before deleting and only removes the model after confirmation", async () => {
    const onRemove = vi.fn();
    renderSingleRow(onRemove);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(useConfirmDialogStore.getState().pendingRequest?.title).toBe("Delete this model?");
    });
    expect(useConfirmDialogStore.getState().pendingRequest?.description).toBe(
      "Model One will be removed from this device. You can download it again later.",
    );
    expect(useConfirmDialogStore.getState().pendingRequest?.confirmVariant).toBe("destructive");
    expect(onRemove).not.toHaveBeenCalled();

    act(() => useConfirmDialogStore.getState().settleConfirmation(false));
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(useConfirmDialogStore.getState().pendingRequest?.title).toBe("Delete this model?");
    });
    act(() => useConfirmDialogStore.getState().settleConfirmation(true));
    await waitFor(() => expect(onRemove).toHaveBeenCalledOnce());
  });

  it("provides Ukrainian copy for every voice dictation message", () => {
    const voiceMessages = Object.keys(enUS).filter(
      (id) =>
        id.startsWith("voiceDictation.") ||
        id === "settings.voiceDictation.title" ||
        id === "settings.shortcuts.command.voiceDictation",
    );
    const untranslated = voiceMessages.filter((id) => !ukUA[id] || ukUA[id] === enUS[id]);

    expect(untranslated).toEqual([]);
  });

  it("localizes catalog descriptions and only advertises streaming for parakeet-family models", () => {
    const parakeetModel: VoiceModelListItem = {
      descriptor: {
        id: "parakeet-unified-en-0.6b",
        name: "Parakeet Unified EN 0.6B",
        description: "Fast, accurate live English transcription.",
        family: "parakeet",
        languageCount: 1,
        streaming: true,
        license: "cc-by-4.0",
        huggingFaceRepo: "owner/parakeet",
        revision: "rev1",
        fileName: "parakeet.gguf",
        sizeBytes: 10,
        sha256: "test",
      },
      state: { status: "ready", path: "/models/parakeet.gguf", sizeBytes: 10, source: "zcode" },
    };
    // В каталоге Nemotron помечен streaming: true, но рантайм-гейт допускает только Parakeet —
    // карточка не должна рекламировать стриминг, которого не будет.
    const nemotronModel: VoiceModelListItem = {
      ...parakeetModel,
      descriptor: {
        ...parakeetModel.descriptor,
        id: "nemotron-speech-streaming-en-0.6b",
        name: "Nemotron Speech Streaming EN",
        description: "English speech-to-text with streaming and token-level timestamps.",
        family: "nemotron",
      },
    };
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(VoiceModelRow, {
          item: parakeetModel,
          selected: false,
          runtimeState: { loadedModelId: null, activeModelId: null, activePhase: null },
          onSelect: () => undefined,
          onUseWhenReady: () => undefined,
          onDownload: () => undefined,
          onCancel: () => undefined,
          onRemove: () => undefined,
        }),
        createElement(VoiceModelRow, {
          item: nemotronModel,
          selected: false,
          runtimeState: { loadedModelId: null, activeModelId: null, activePhase: null },
          onSelect: () => undefined,
          onUseWhenReady: () => undefined,
          onDownload: () => undefined,
          onCancel: () => undefined,
          onRemove: () => undefined,
        }),
      ),
    );

    // Описания идут из i18n, а не из английского каталога.
    expect(screen.getByText("Fast, accurate live English transcription.")).toBeTruthy();
    expect(
      screen.getByText("English speech-to-text with streaming and token-level timestamps."),
    ).toBeTruthy();
    const streamingBadges = screen.getAllByText("Streaming");
    expect(streamingBadges).toHaveLength(1);
  });
});
