// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoDefaults } from "@zcode/shared";
import {
  TID_V4_COMPOSER_INCOGNITO_MARKER,
  TID_V4_COMPOSER_INCOGNITO_TRIGGER,
  V4ComposerIncognitoControl,
} from "@/v4/composer/V4ComposerIncognitoControl.js";
import { useDraftIncognitoIntentStore } from "@/v4/composer/draftIncognitoIntent.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  cleanup();
  useDraftIncognitoIntentStore.setState({ capabilitiesByWorkspaceKey: {} });
});

// specs/incognito-session.md "Composer toggle": pressed state and a removable chip, never color-only.
it("shows a pressed trigger and a removable chip while the draft is incognito", () => {
  render(createElement(V4ComposerIncognitoControl, { workspaceKey: "/ws" }));
  const trigger = screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_TRIGGER);
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByTestId(TID_V4_COMPOSER_INCOGNITO_MARKER)).toBeNull();

  act(() => {
    useDraftIncognitoIntentStore
      .getState()
      .activate("/ws", resolveIncognitoDefaults({ mcp: true }));
  });
  expect(screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_TRIGGER).getAttribute("aria-pressed")).toBe(
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: "chat.incognito.removeMarker" }));
  expect(useDraftIncognitoIntentStore.getState().capabilitiesByWorkspaceKey).toEqual({});
  expect(screen.queryByTestId(TID_V4_COMPOSER_INCOGNITO_MARKER)).toBeNull();
});
