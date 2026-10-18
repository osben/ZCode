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
    // The panel itself ignores pointer events so it never blocks the toolbar; the button opts back in.
    expect(cancel.className).toContain("pointer-events-auto");
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
