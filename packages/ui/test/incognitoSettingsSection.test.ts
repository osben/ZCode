// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoDefaults, type AppSettings } from "@zcode/shared";
import { IncognitoSettingsSection } from "@/settings/IncognitoSettingsSection.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

afterEach(cleanup);

// specs/incognito-session.md: the sidecar replaces incognitoDefaults as a whole, so the section
// always writes the full resolved object with one capability flipped.
it("shows every capability off by default and writes the full defaults object", () => {
  const onUpdate = vi.fn();
  render(
    createElement(IncognitoSettingsSection, {
      settings: { incognitoDefaults: { mcp: true } } as AppSettings,
      onUpdate,
    }),
  );

  expect(screen.getByTestId("settings-incognito-mcp").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByTestId("settings-incognito-skills").getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(screen.getByText("settings.incognito.scopeHint")).toBeTruthy();

  fireEvent.click(screen.getByTestId("settings-incognito-skills"));
  expect(onUpdate).toHaveBeenCalledWith({
    incognitoDefaults: { ...resolveIncognitoDefaults({ mcp: true }), skills: true },
  });
});
