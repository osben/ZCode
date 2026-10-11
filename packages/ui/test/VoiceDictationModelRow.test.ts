// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictationRuntimeState, VoiceModelListItem } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import ukUA from "@/i18n/locales/uk-UA.js";
import { VoiceModelRow } from "@/settings/VoiceDictationModelRow.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

afterEach(cleanup);

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

function renderRows(runtimeState: VoiceDictationRuntimeState, now: number) {
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
          now,
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
          now,
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
        runtimeState: { loadedModelId: null, activeModelId: null, idleUnloadAt: null },
        now: 0,
        onSelect: () => undefined,
        onUseWhenReady: () => undefined,
        onDownload: () => undefined,
        onCancel: () => undefined,
        onRemove,
      }),
    ),
  );
}

describe("VoiceModelRow runtime status", () => {
  it("keeps the selected model distinct from the loaded model and shows its unload time", () => {
    renderRows(
      { loadedModelId: "model-two", activeModelId: null, idleUnloadAt: 1_299_000 },
      1_000_000,
    );

    expect(screen.getByText("Next dictation")).toBeTruthy();
    expect(screen.getByText("Loaded in memory · unloads in 4:59")).toBeTruthy();
  });

  it("shows when the loaded model is transcribing instead of an idle countdown", () => {
    renderRows({ loadedModelId: "model-one", activeModelId: "model-one", idleUnloadAt: null }, 0);

    expect(screen.getByText("Transcribing")).toBeTruthy();
    expect(screen.queryByText(/unloads in/)).toBeNull();
  });

  it("shows active streaming transcription distinctly", () => {
    renderRows(
      {
        loadedModelId: "model-one",
        activeModelId: "model-one",
        activePhase: "streaming",
        idleUnloadAt: null,
      },
      0,
    );

    expect(screen.getByText("Streaming transcription")).toBeTruthy();
    expect(screen.queryByText(/unloads in/)).toBeNull();
  });
});

describe("VoiceModelRow model actions", () => {
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
});
