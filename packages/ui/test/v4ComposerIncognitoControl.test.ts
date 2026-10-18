// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoDefaults, type IncognitoCapabilities } from "@zcode/shared";
import {
  TID_V4_COMPOSER_INCOGNITO_MARKER,
  TID_V4_COMPOSER_INCOGNITO_OFF,
  TID_V4_COMPOSER_INCOGNITO_TOGGLE,
  TID_V4_COMPOSER_INCOGNITO_TRIGGER,
  V4ComposerIncognitoControl,
} from "@/v4/composer/V4ComposerIncognitoControl.js";
import {
  selectDraftIncognito,
  useDraftIncognitoIntentStore,
} from "@/v4/composer/draftIncognitoIntent.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuCheckboxItem: ({
    checked,
    onCheckedChange,
    "data-testid": testId,
    children,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    "data-testid": string;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      {
        role: "menuitemcheckbox",
        "aria-checked": String(checked),
        "data-testid": testId,
        onClick: () => onCheckedChange(!checked),
      },
      children,
    ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

let resolveDefaultsRead: ((defaults: IncognitoCapabilities) => void) | undefined;
vi.mock("@/hooks/useIncognitoDefaultsReader.js", () => ({
  useIncognitoDefaultsReader: () => () =>
    new Promise<IncognitoCapabilities>((resolve) => {
      resolveDefaultsRead = resolve;
    }),
}));

afterEach(() => {
  cleanup();
  resolveDefaultsRead = undefined;
  useDraftIncognitoIntentStore.setState({
    capabilitiesByWorkspaceKey: {},
    generationByWorkspaceKey: {},
  });
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

  fireEvent.click(screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_OFF));
  expect(useDraftIncognitoIntentStore.getState().capabilitiesByWorkspaceKey).toEqual({});
  expect(screen.queryByTestId(TID_V4_COMPOSER_INCOGNITO_MARKER)).toBeNull();
});

// specs/incognito-session.md "Composer toggle": the turn-off button is an inline sibling of the
// trigger inside the active chip (project-chip pattern), never a second control beside it.
it("places exactly one turn-off button inside the active chip and none while off", () => {
  render(createElement(V4ComposerIncognitoControl, { workspaceKey: "/ws" }));
  expect(screen.queryByTestId(TID_V4_COMPOSER_INCOGNITO_OFF)).toBeNull();

  act(() => {
    useDraftIncognitoIntentStore
      .getState()
      .activate("/ws", resolveIncognitoDefaults({ mcp: true }));
  });
  const chip = screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_MARKER);
  const off = screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_OFF);
  expect(chip.contains(off)).toBe(true);
  expect(chip.contains(screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_TRIGGER))).toBe(true);
  expect(off.getAttribute("aria-label")).toBe("chat.incognito.turnOff");
  expect(screen.getAllByRole("button", { name: "chat.incognito.turnOff" })).toHaveLength(1);
  // The turn-off button must not nest inside the trigger button.
  expect(screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_TRIGGER).contains(off)).toBe(false);
});

// specs/incognito-session.md "Composer toggle": the control lives in the composer top row, outside
// the bottom toolbar fit, so it never receives a collapse priority and never collapses to an icon.
it("is placed at the trailing end of the top row and is not a toolbar collapse participant", () => {
  const { container } = render(createElement(V4ComposerIncognitoControl, { workspaceKey: "/ws" }));
  const root = container.firstElementChild as HTMLElement;
  expect(root.className).toContain("ml-auto");
  expect(container.querySelector("[data-composer-collapse-priority]")).toBeNull();

  act(() => {
    useDraftIncognitoIntentStore
      .getState()
      .activate("/ws", resolveIncognitoDefaults({ mcp: true }));
  });
  const marker = screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_MARKER);
  expect(marker.hasAttribute("data-composer-collapse-priority")).toBe(false);
  expect(marker.querySelector("[data-composer-compact]")).toBeNull();
  expect(container.querySelector("[data-composer-collapse-priority]")).toBeNull();
});

it("disables the turn-off button together with the control", () => {
  act(() => {
    useDraftIncognitoIntentStore
      .getState()
      .activate("/ws", resolveIncognitoDefaults({ mcp: true }));
  });
  render(createElement(V4ComposerIncognitoControl, { workspaceKey: "/ws", disabled: true }));
  expect((screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_OFF) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

// specs/incognito-session.md scenario 18 (composer half): the defaults read resolves after the
// draft was sent or unchecked, so the late activation must be discarded instead of arming the
// next draft.
it("discards the activation when the draft was submitted before the defaults read resolved", () => {
  render(createElement(V4ComposerIncognitoControl, { workspaceKey: "/ws" }));
  const toggleRow = screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_TOGGLE);

  fireEvent.click(toggleRow);
  expect(resolveDefaultsRead).toBeTypeOf("function");
  // The draft is sent while the defaults read is still pending.
  expect(useDraftIncognitoIntentStore.getState().captureForSubmission("/ws")).toBeUndefined();

  act(() => {
    resolveDefaultsRead?.(resolveIncognitoDefaults({ mcp: true }));
  });
  expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "/ws")).toBeNull();
});

it("discards the activation when the intent was deactivated before the read resolved", () => {
  render(createElement(V4ComposerIncognitoControl, { workspaceKey: "/ws" }));
  fireEvent.click(screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_TOGGLE));
  expect(resolveDefaultsRead).toBeTypeOf("function");

  // Another flow consumes the intent while the defaults read is still pending (for example the
  // send cleanup of a previous draft).
  act(() => {
    useDraftIncognitoIntentStore.getState().deactivate("/ws");
  });

  act(() => {
    resolveDefaultsRead?.(resolveIncognitoDefaults({ mcp: true }));
  });
  expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "/ws")).toBeNull();
});

it("arms the intent from the defaults when nothing intervened", async () => {
  render(createElement(V4ComposerIncognitoControl, { workspaceKey: "/ws" }));
  fireEvent.click(screen.getByTestId(TID_V4_COMPOSER_INCOGNITO_TOGGLE));

  await act(async () => {
    resolveDefaultsRead?.(resolveIncognitoDefaults({ mcp: true }));
    await Promise.resolve();
  });
  expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "/ws")).toEqual(
    resolveIncognitoDefaults({ mcp: true }),
  );
});
