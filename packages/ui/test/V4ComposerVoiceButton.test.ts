// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
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
  });
});
