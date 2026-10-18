// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => null,
}));

import { V4ComposerVoiceButton } from "@/v4/composer/V4ComposerVoiceButton.js";

afterEach(cleanup);

describe("V4ComposerVoiceButton live feedback", () => {
  it("shows microphone level and keeps the stream preview out of the editable input", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "recording",
          level: 0.6,
          preview: { committed: "Hello ", tentative: "world" },
          onToggle: () => undefined,
        }),
      ),
    );

    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("60");
    expect(screen.getByTestId("voice-dictation-preview").textContent).toContain("Hello ");
    expect(screen.getByTestId("voice-dictation-preview").textContent).toContain("world");
    // Вариант "listening" теперь встречается дважды: видимый лейбл панели и sr-only live region.
    expect(screen.getByTestId("voice-dictation-feedback").textContent).toContain(
      "voiceDictation.composer.listening",
    );
    expect(screen.getAllByRole("status").length).toBe(2);
    expect(screen.getByTestId("voice-dictation-feedback").className).toContain("absolute");
    expect(screen.getByTestId("voice-dictation-feedback").className).toContain("w-56");
    expect(screen.getByTestId("voice-dictation-control").className).toContain("relative");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("hides the level meter and preview after recording stops", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "idle",
          level: 0,
          preview: null,
          onToggle: () => undefined,
        }),
      ),
    );

    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByTestId("voice-dictation-preview")).toBeNull();
    // Постоянный live region объявляет и не-Recording фазы; без превью он единственный role="status".
    expect(screen.getByRole("status").textContent).toBe("voiceDictation.composer.status.idle");
  });

  it("offers a clickable Cancel inside the recording panel only when a handler is given", () => {
    const onCancel = vi.fn();
    const renderPanel = (handler?: () => void) =>
      render(
        createElement(
          TooltipProvider,
          null,
          createElement(V4ComposerVoiceButton, {
            phase: "recording",
            level: 0.2,
            preview: null,
            onToggle: () => undefined,
            onCancel: handler,
          }),
        ),
      );

    renderPanel();
    expect(screen.queryByTestId("voice-dictation-cancel")).toBeNull();
    cleanup();

    renderPanel(onCancel);
    const cancel = screen.getByTestId("voice-dictation-cancel");
    expect(cancel.getAttribute("aria-label")).toBe("voiceDictation.composer.cancel");
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("makes the visible panel body a hit target so covered toolbar actions get no pointer input (VD-PNL-01)", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "recording",
          level: 0.2,
          preview: null,
          onToggle: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );
    const panel = screen.getByTestId("voice-dictation-feedback");
    expect(panel.className).toContain("pointer-events-auto");
    expect(panel.className).not.toContain("pointer-events-none");
    // The stop/mic button sits outside the panel and must stay clickable.
    expect(screen.getByTestId("v4-composer-voice-entry").contains(panel)).toBe(false);
  });

  it("keeps editor focus when the panel body is pressed (VD-PNL-03)", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          "div",
          null,
          createElement("textarea", { "data-testid": "editor-stub" }),
          createElement(V4ComposerVoiceButton, {
            phase: "recording",
            level: 0.2,
            preview: null,
            onToggle: () => undefined,
            onCancel: () => undefined,
          }),
        ),
      ),
    );
    const editor = screen.getByTestId("editor-stub") as HTMLTextAreaElement;
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const panel = screen.getByTestId("voice-dictation-feedback");
    const notPrevented = fireEvent.mouseDown(panel);
    // fireEvent returns false when the handler called preventDefault.
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);

    // The panel is passive status UI: it must not become a focus target itself.
    expect(panel.hasAttribute("tabindex")).toBe(false);
  });

  const renderStatus = (phase: "idle" | "recording" | "loading", modelStatus?: string) =>
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase,
          level: 0,
          preview: null,
          modelStatus: modelStatus as never,
          onToggle: () => undefined,
        }),
      ),
    );

  it("shows a pulsing warning dot while the model loads and a success dot once loaded", () => {
    renderStatus("idle", "loading");
    const loading = screen.getByTestId("voice-model-status-dot");
    expect(loading.getAttribute("data-status")).toBe("loading");
    expect(loading.className).toContain("bg-warning");
    expect(loading.className).toContain("animate-pulse");
    expect(loading.className).toContain("motion-reduce:animate-none");
    cleanup();

    renderStatus("idle", "loaded");
    const loaded = screen.getByTestId("voice-model-status-dot");
    expect(loaded.getAttribute("data-status")).toBe("loaded");
    expect(loaded.className).toContain("bg-success");
    expect(loaded.className).not.toContain("animate-pulse");
  });

  it("describes the status in text for assistive technology, not only by color", () => {
    renderStatus("idle", "loaded");
    const button = screen.getByTestId("v4-composer-voice-entry");
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "voiceDictation.composer.modelStatus.loaded",
    );
  });

  it("shows no dot when idle, without a model, or while recording or busy", () => {
    for (const [phase, status] of [
      ["idle", "idle"],
      ["idle", "none"],
      ["recording", "loaded"],
      ["loading", "loaded"],
    ] as const) {
      renderStatus(phase, status);
      expect(screen.queryByTestId("voice-model-status-dot")).toBeNull();
      cleanup();
    }
  });

  it("shows a busy, non-clickable state labelled Processing while the transcript is post-processed", () => {
    const onToggle = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "processing",
          level: 0,
          preview: null,
          onToggle,
        }),
      ),
    );
    const button = screen.getByTestId("v4-composer-voice-entry");
    expect(button.getAttribute("aria-label")).toBe("voiceDictation.composer.processing");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-voice-phase")).toBe("processing");
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "voiceDictation.composer.status.processing",
    );
  });
});
