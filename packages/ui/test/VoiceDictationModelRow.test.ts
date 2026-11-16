// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictationRuntimeState, VoiceModelListItem } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import ukUA from "@/i18n/locales/uk-UA.js";
import {
  formatVoiceModelDownloadSpeed,
  MODEL_DESCRIPTION_MESSAGE_IDS,
  VoiceModelRow,
} from "@/settings/VoiceDictationModelRow.js";
import { VOICE_MODEL_CATALOG } from "../../services/src/voice-dictation/voiceModelCatalog.js";
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
    languages: ["en"],
    streaming: false,
    license: "mit",
    huggingFaceRepo: "owner/model-one",
    revision: "abc123",
    minEngine: "0.2.4",
    defaultQuant: "Q8_0",
    quants: {
      Q8_0: { fileName: "model-one.gguf", sizeBytes: 10, sha256: "test" },
      Q4_K_M: { fileName: "model-one-Q4_K_M.gguf", sizeBytes: 6, sha256: "test" },
    },
  },
  states: {
    Q8_0: { status: "ready", path: "/models/model-one.gguf", sizeBytes: 10, source: "zcode" },
    Q4_K_M: { status: "not_downloaded" },
  },
};

const secondModel: VoiceModelListItem = {
  ...firstModel,
  descriptor: { ...firstModel.descriptor, id: "model-two", name: "Model Two" },
  states: {
    Q8_0: { status: "ready", path: "/models/model-two.gguf", sizeBytes: 10, source: "zcode" },
    Q4_K_M: { status: "not_downloaded" },
  },
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
          states: {
            Q8_0: { status: "downloading", downloadedBytes: bytes, totalBytes },
            Q4_K_M: { status: "not_downloaded" },
          },
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
    // Pending-use wording is one term ("Use when ready") across the badge and the card action.
    expect(screen.queryByText("Use when ready")).toBeTruthy();
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

  it("localizes catalog descriptions and advertises streaming only for catalog-flagged models", () => {
    const quantFile = { fileName: "model.gguf", sizeBytes: 10, sha256: "test" };
    const parakeetModel: VoiceModelListItem = {
      descriptor: {
        id: "parakeet-unified-en-0.6b",
        name: "Parakeet Unified EN 0.6B",
        description: "Fast, accurate live English transcription.",
        family: "parakeet",
        languages: ["en"],
        streaming: true,
        license: "cc-by-4.0",
        huggingFaceRepo: "owner/parakeet",
        revision: "rev1",
        minEngine: "0.2.4",
        defaultQuant: "Q8_0",
        quants: { Q8_0: quantFile },
      },
      states: {
        Q8_0: { status: "ready", path: "/models/parakeet.gguf", sizeBytes: 10, source: "zcode" },
      },
    };
    // A model the catalog does not flag as streaming must not show the badge, whatever its family.
    const nemotronModel: VoiceModelListItem = {
      ...parakeetModel,
      descriptor: {
        ...parakeetModel.descriptor,
        id: "nemotron-speech-streaming-en-0.6b",
        name: "Nemotron Speech Streaming EN",
        description: "English speech-to-text with streaming and token-level timestamps.",
        family: "nemotron",
        streaming: false,
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

describe("VoiceModelRow languages and recommendation", () => {
  const manyLanguages = ["en", "de", "fr", "es", "it", "uk", "ru", "ja"];
  const names: Record<string, string> = {
    en: "English",
    de: "German",
    fr: "French",
    es: "Spanish",
    it: "Italian",
    uk: "Ukrainian",
    ru: "Russian",
    ja: "Japanese",
  };
  const renderLanguageRow = (props: Record<string, unknown> = {}) =>
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(VoiceModelRow, {
          item: {
            ...firstModel,
            descriptor: { ...firstModel.descriptor, languages: manyLanguages },
          },
          selected: false,
          runtimeState: { loadedModelId: null, activeModelId: null, activePhase: null },
          languageName: (code: string) => names[code] ?? code,
          onSelect: () => undefined,
          onUseWhenReady: () => undefined,
          onDownload: () => undefined,
          onCancel: () => undefined,
          onRemove: () => undefined,
          ...props,
        }),
      ),
    );

  it("lists supported languages as chips, selected ones first, with an expandable overflow", () => {
    renderLanguageRow({ selectedLanguages: ["uk", "ja"] });

    const chips = screen.getAllByTestId("voice-model-language-chip").map((c) => c.textContent);
    expect(chips).toEqual(["Ukrainian", "Japanese", "English", "German", "French"]);
    const toggle = screen.getByRole("button", { name: /Show all 8 languages/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("+3");

    fireEvent.click(toggle);

    expect(screen.getAllByTestId("voice-model-language-chip")).toHaveLength(8);
    const collapse = screen.getByRole("button", { name: /Show fewer languages/ });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows every chip without an overflow button for short language lists", () => {
    renderLanguageRow({
      item: { ...firstModel, descriptor: { ...firstModel.descriptor, languages: ["en", "de"] } },
    });

    expect(screen.getAllByTestId("voice-model-language-chip")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("marks the recommended model", () => {
    const { rerender } = renderLanguageRow();
    expect(screen.queryByText("Recommended")).toBeNull();
    cleanup();
    renderLanguageRow({ recommended: true });
    expect(screen.getByText("Recommended")).toBeTruthy();
    void rerender;
  });
});

describe("model descriptions are localized for the models we translate", () => {
  /** Models that predate the Handy catalog refresh keep localized descriptions (VD-11). */
  const LEGACY_MODEL_IDS = [
    "whisper-tiny",
    "whisper-base",
    "whisper-small",
    "whisper-medium",
    "whisper-large-v3",
    "whisper-large-v3-turbo",
    "parakeet-unified-en-0.6b",
    "parakeet-tdt-0.6b-v3",
    "canary-180m-flash",
    "canary-1b-v2",
    "nemotron-speech-streaming-en-0.6b",
    "nemotron-3.5-asr-streaming-0.6b",
    "gigaam-v3-e2e-rnnt",
  ];

  it("maps each translated id to a message that exists in every locale", () => {
    for (const [id, messageId] of Object.entries(MODEL_DESCRIPTION_MESSAGE_IDS)) {
      expect(messageId, `${id} has no message id`).toBeTruthy();
      for (const catalog of [enUS, ukUA]) {
        expect((catalog as Record<string, string>)[messageId], `${id} / ${messageId}`).toBeTruthy();
      }
    }
    const catalogIds = new Set(VOICE_MODEL_CATALOG.map(({ id }) => id));
    const translatedIds = new Set(Object.keys(MODEL_DESCRIPTION_MESSAGE_IDS));
    for (const id of LEGACY_MODEL_IDS) {
      expect(catalogIds.has(id), `${id} disappeared from the catalog`).toBeTruthy();
      expect(translatedIds.has(id), `${id} lost its localized description`).toBeTruthy();
    }
  });
});

describe("VoiceModelRow quantization", () => {
  const runtimeState = { loadedModelId: null, activeModelId: null, activePhase: null };

  function renderRow(props: Record<string, unknown> = {}) {
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(VoiceModelRow, {
          item: firstModel,
          selected: false,
          runtimeState,
          onSelect: () => undefined,
          onUseWhenReady: () => undefined,
          onDownload: () => undefined,
          onCancel: () => undefined,
          onRemove: () => undefined,
          ...props,
        }),
      ),
    );
  }

  it("shows the quantization picker only for models with several quantizations", () => {
    const onQuantChange = vi.fn();
    const view = renderRow({ onQuantChange });
    const select = view.container.querySelector("[data-testid='voice-model-quant-select']");
    expect(select).toBeTruthy();
    expect(select?.textContent).toContain("Q8_0");
    cleanup();

    const singleQuant = {
      ...firstModel,
      descriptor: {
        ...firstModel.descriptor,
        quants: { Q8_0: firstModel.descriptor.quants.Q8_0! },
      },
    };
    const single = renderRow({ item: singleQuant, onQuantChange });
    expect(single.container.querySelector("[data-testid='voice-model-quant-select']")).toBeNull();
  });

  it("acts on the selected quantization, not just the default", () => {
    const onDownload = vi.fn();
    const onRemove = vi.fn();
    const onQuantChange = vi.fn();
    const q4Selected = renderRow({ quant: "Q4_K_M", onDownload, onRemove, onQuantChange });

    // Q4_K_M is not downloaded: the primary action downloads that quantization.
    fireEvent.click(q4Selected.getByRole("button", { name: /Model One: Download/i }));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onQuantChange).not.toHaveBeenCalled();
  });

  it("shows the curated badge only for curated models", () => {
    const curated = renderRow({
      item: {
        ...firstModel,
        descriptor: { ...firstModel.descriptor, curated: true },
      },
    });
    expect(curated.getByText("Handy pick")).toBeTruthy();
    cleanup();
    const plain = renderRow();
    expect(plain.queryByText("Handy pick")).toBeNull();
  });
});
