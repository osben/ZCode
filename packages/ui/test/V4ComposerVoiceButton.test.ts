// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** A level subscription the test controls: emits nothing until the test pushes peaks. */
function manualLevelSubscription() {
  let listener: ((peak: number) => void) | undefined;
  return {
    subscribeLevel: (callback: (peak: number) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    emit: (peak: number) => listener?.(peak),
  };
}

const silentSubscription = () => () => undefined;

describe("V4ComposerVoiceButton toolbar cluster", () => {
  it("shows the peak-history waveform in the capsule; the transcript preview is not rendered here (VD-LIVE-01, VD-GHO-01)", () => {
    const level = manualLevelSubscription();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "recording",
          subscribeLevel: level.subscribeLevel,
          onToggle: () => undefined,
        }),
      ),
    );

    // Silent start: all bars rest at the 3 px floor and none counts as active.
    const waveform = screen.getByTestId("voice-dictation-waveform");
    expect(waveform.getAttribute("aria-hidden")).toBe("true");
    expect(waveform.getAttribute("data-voice-active-bars")).toBe("0");

    // Audible peaks light bars one per chunk; silence afterwards adds no active bar.
    act(() => {
      level.emit(0.5);
      level.emit(0.5);
      level.emit(0);
    });
    expect(
      screen.getByTestId("voice-dictation-waveform").getAttribute("data-voice-active-bars"),
    ).toBe("2");

    // The ghost preview lives in the editor layer; the button must never render transcript text.
    expect(screen.queryByTestId("voice-dictation-preview")).toBeNull();
    // Only the persistent live region is a status; the capsule adds no second announcement.
    expect(screen.getAllByRole("status").length).toBe(1);
    expect(screen.getByRole("status").textContent).toBe("voiceDictation.composer.listening");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not render an overlay: the capsule is in flow and never absolutely positioned (VD-CLU-01)", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "recording",
          subscribeLevel: silentSubscription,
          onToggle: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );
    const cluster = screen.getByTestId("voice-dictation-cluster");
    expect(cluster.className).not.toContain("absolute");
    expect(cluster.className).not.toContain("pointer-events-auto");
    expect(cluster.className).not.toContain("w-56");
    expect(cluster.className).toContain("bg-voice-input-surface");
    // The stop button lives INSIDE the capsule (upstream shape); the capsule never contains itself.
    expect(screen.getByTestId("v4-composer-voice-entry").contains(cluster)).toBe(false);
    expect(cluster.contains(screen.getByTestId("v4-composer-voice-entry"))).toBe(true);
  });

  it("hides the waveform and capsule after recording stops", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "idle",
          subscribeLevel: silentSubscription,
          onToggle: () => undefined,
        }),
      ),
    );

    expect(screen.queryByTestId("voice-dictation-waveform")).toBeNull();
    expect(screen.queryByTestId("voice-dictation-cluster")).toBeNull();
    // Постоянный live region объявляет и не-Recording фазы.
    expect(screen.getByRole("status").textContent).toBe("voiceDictation.composer.status.idle");
  });

  it("offers a clickable Cancel in the capsule only when a handler is given (VD-CLU-02)", () => {
    const onCancel = vi.fn();
    const renderCluster = (handler?: () => void) =>
      render(
        createElement(
          TooltipProvider,
          null,
          createElement(V4ComposerVoiceButton, {
            phase: "recording",
            subscribeLevel: silentSubscription,
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

  it("keeps editor focus when the capsule is pressed (VD-CLU-03)", () => {
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
            subscribeLevel: silentSubscription,
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

    // The capsule is passive status UI: it must not become a focus target itself.
    expect(cluster.hasAttribute("tabindex")).toBe(false);
  });

  const renderStatus = (phase: "idle" | "recording" | "loading", modelStatus?: string) =>
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase,
          subscribeLevel: silentSubscription,
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

  it("renders the microphone permission guide instead of recording when permissionGuide is set", () => {
    const renderGuide = (phase: "denied" | "restart-required") =>
      render(
        createElement(
          TooltipProvider,
          null,
          createElement(V4ComposerVoiceButton, {
            phase: "idle",
            subscribeLevel: silentSubscription,
            onToggle: () => undefined,
            permissionGuide: phase,
            onReauthorizeMicrophone: () => undefined,
          }),
        ),
      );

    // jsdom reports no Mac platform, so the denied guide shows the Windows copy without
    // Re-authorize; Open System Settings is always available.
    renderGuide("denied");
    const guide = screen.getByTestId("voice-permission-guide");
    expect(guide.getAttribute("data-voice-permission-phase")).toBe("denied");
    expect(screen.getByText("voiceDictation.permission.windowsDenied")).toBeTruthy();
    expect(screen.getByText("voiceDictation.permission.openSettings")).toBeTruthy();
    expect(screen.queryByText("voiceDictation.permission.reauthorize")).toBeNull();
    cleanup();

    // Restart-required swaps the copy and offers the relaunch action instead.
    renderGuide("restart-required");
    expect(
      screen.getByTestId("voice-permission-guide").getAttribute("data-voice-permission-phase"),
    ).toBe("restart-required");
    expect(screen.getByText("voiceDictation.permission.restart")).toBeTruthy();
    expect(screen.getByText("voiceDictation.permission.relaunch")).toBeTruthy();
  });

  it("shows a busy, non-clickable state labelled Processing while the transcript is post-processed", () => {
    const onToggle = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerVoiceButton, {
          phase: "processing",
          subscribeLevel: silentSubscription,
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
