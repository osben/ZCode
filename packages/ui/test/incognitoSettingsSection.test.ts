// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoDefaults, type AppSettings } from "@zcode/shared";
import { IncognitoSettingsSection } from "@/settings/IncognitoSettingsSection.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

afterEach(cleanup);

// specs/incognito-session.md: the sidecar replaces incognitoDefaults as a whole, so the section
// always writes the full resolved object with one capability flipped. Writes are serialized, so
// the call lands after a microtask.
it("shows every capability off by default and writes the full defaults object", async () => {
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
  await act(async () => {
    await Promise.resolve();
  });
  expect(onUpdate).toHaveBeenCalledWith({
    incognitoDefaults: { ...resolveIncognitoDefaults({ mcp: true }), skills: true },
  });
});

// specs/incognito-session.md scenario 18 (Settings half): a full-object write races with the
// settings refresh, so quick toggles compose on the optimistic draft instead of the second write
// erasing the first.
it("composes rapid toggles before the first write refreshed the settings", async () => {
  const resolvers: Array<() => void> = [];
  const onUpdate = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
  render(
    createElement(IncognitoSettingsSection, {
      settings: { incognitoDefaults: { mcp: true } } as AppSettings,
      onUpdate,
    }),
  );

  fireEvent.click(screen.getByTestId("settings-incognito-skills"));
  fireEvent.click(screen.getByTestId("settings-incognito-hooks"));
  // The optimistic draft reflects both toggles immediately.
  expect(screen.getByTestId("settings-incognito-skills").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByTestId("settings-incognito-hooks").getAttribute("aria-checked")).toBe("true");

  await act(async () => {
    await Promise.resolve();
  });
  const base = resolveIncognitoDefaults({ mcp: true });
  expect(onUpdate).toHaveBeenNthCalledWith(1, {
    incognitoDefaults: { ...base, skills: true },
  });
  // Serialized: the second write only starts after the first write completed.
  resolvers[0]();
  await act(async () => {
    await Promise.resolve();
  });
  // The second write must compose on the first, not on the stale rendered defaults.
  expect(onUpdate).toHaveBeenNthCalledWith(2, {
    incognitoDefaults: { ...base, skills: true, hooks: true },
  });

  resolvers[1]();
  await act(async () => {
    await Promise.resolve();
  });
  expect(onUpdate).toHaveBeenCalledTimes(2);
});

it("reverts the draft to the stored defaults when a write fails", async () => {
  const onUpdate = vi.fn(() => Promise.reject(new Error("write failed")));
  render(
    createElement(IncognitoSettingsSection, {
      settings: { incognitoDefaults: { mcp: true } } as AppSettings,
      onUpdate,
    }),
  );

  fireEvent.click(screen.getByTestId("settings-incognito-skills"));
  expect(screen.getByTestId("settings-incognito-skills").getAttribute("aria-checked")).toBe("true");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByTestId("settings-incognito-skills").getAttribute("aria-checked")).toBe(
    "false",
  );
});
