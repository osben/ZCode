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

describe("V4ComposerVoiceButton toolbar cluster", () => {
  it("shows the microphone level in the toolbar cluster; the transcript preview is not rendered here (VD-LIVE-01, VD-GHO-01)", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "recording",
          level: 0.6,
          onToggle: () => undefined,
        }),
      ),
    );

    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("60");
    // The ghost preview lives in the editor layer; the button must never render transcript text.
    expect(screen.queryByTestId("voice-dictation-preview")).toBeNull();
    // Only the persistent live region is a status; the cluster adds no second announcement.
    expect(screen.getAllByRole("status").length).toBe(1);
    expect(screen.getByRole("status").textContent).toBe("voiceDictation.composer.listening");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not render an overlay: the cluster is in flow and never absolutely positioned (VD-CLU-01)", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "recording",
          level: 0.2,
          onToggle: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );
    const cluster = screen.getByTestId("voice-dictation-cluster");
    expect(cluster.className).not.toContain("absolute");
    expect(cluster.className).not.toContain("pointer-events-auto");
    expect(cluster.className).not.toContain("w-56");
    // The stop/mic button is a sibling of the cluster, not inside it.
    expect(screen.getByTestId("v4-composer-voice-entry").contains(cluster)).toBe(false);
  });

  it("hides the level meter and cluster after recording stops", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "idle",
          level: 0,
          onToggle: () => undefined,
        }),
      ),
    );

    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByTestId("voice-dictation-cluster")).toBeNull();
    // Постоянный live region объявляет и не-Recording фазы.
    expect(screen.getByRole("status").textContent).toBe("voiceDictation.composer.status.idle");
  });

  it("offers a clickable Cancel in the cluster only when a handler is given (VD-CLU-02)", () => {
    const onCancel = vi.fn();
    const renderCluster = (handler?: () => void) =>
      render(
        createElement(
          TooltipProvider,
          null,
          createElement(V4ComposerVoiceButton, {
            phase: "recording",
            level: 0.2,
            onToggle: () => undefined,
            onCancel: handler,
          }),
        ),
      );

    renderCluster();
    expect(screen.queryByTestId("voice-dictation-cancel")).toBeNull();
    cleanup();

    renderCluster(onCancel);
    const cancel = screen.getByTestId("voice-dictation-cancel");
    expect(cancel.getAttribute("aria-label")).toBe("voiceDictation.composer.cancel");
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps editor focus when the cluster is pressed (VD-CLU-03)", () => {
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
            onToggle: () => undefined,
            onCancel: () => undefined,
          }),
        ),
      ),
    );
    const editor = screen.getByTestId("editor-stub") as HTMLTextAreaElement;
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const cluster = screen.getByTestId("voice-dictation-cluster");
    const notPrevented = fireEvent.mouseDown(cluster);
    // fireEvent returns false when the handler called preventDefault.
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);

    // The cluster is passive status UI: it must not become a focus target itself.
    expect(cluster.hasAttribute("tabindex")).toBe(false);
  });

  const renderStatus = (phase: "idle" | "recording" | "loading", modelStatus?: string) =>
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase,
          level: 0,
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

  it("describes the loading status in text for assistive technology", () => {
    renderStatus("idle", "loading");
    const button = screen.getByTestId("v4-composer-voice-entry");
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "voiceDictation.composer.modelStatus.loading",
    );
  });

  it("gives the loaded dot no text: decorative, no description, no tooltip text (non-essential hint)", () => {
    renderStatus("idle", "loaded");
    const dot = screen.getByTestId("voice-model-status-dot");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    const button = screen.getByTestId("v4-composer-voice-entry");
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById("voice-model-status-text")).toBeNull();
    expect(button.getAttribute("aria-label")).toBe("voiceDictation.composer.start");
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
