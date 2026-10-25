import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";

// Radix menus render nothing while closed; replace the primitives with pass-through wrappers and verify the item structure only.
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) =>
    createElement("div", { role: "menuitem", "data-testid": props["data-testid"] }, children),
  DropdownMenuSeparator: () => createElement("hr", { "data-slot": "dropdown-menu-separator" }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

function storeItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "skill-creator@zcode-plugins-official",
    name: "skill-creator",
    marketplace: "zcode-plugins-official",
    installed: true,
    restorable: false,
    orphaned: false,
    ...overrides,
  };
}

function makeActions(overrides: Partial<PluginStoreActions> = {}): PluginStoreActions {
  return {
    onOpenDetail: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onUpdate: () => {},
    activeOperations: [],
    togglingPluginId: null,
    ...overrides,
  };
}

async function renderMenu(item: StorePluginItem, actions: PluginStoreActions): Promise<string> {
  const { PluginStoreItemMenu } = await import("../src/settings/PluginStoreCard.js");
  return renderToStaticMarkup(createElement(PluginStoreItemMenu, { item, actions }));
}

describe("PluginStoreItemMenu separator", () => {
  // Bug: with only the uninstall action left, a separator still rendered above it as an orphan line.
  it("renders no separator when the menu has only the uninstall action", async () => {
    const html = await renderMenu(storeItem(), makeActions());

    expect(html).toContain('data-testid="plugin-store-menu-uninstall"');
    expect(html).not.toContain('data-slot="dropdown-menu-separator"');
  });

  it("leaves no separator in an uninstall-only menu once update moved inline", async () => {
    const html = await renderMenu(
      storeItem({
        installedMeta: {
          id: "skill-creator@zcode-plugins-official",
          name: "skill-creator",
          marketplace: "zcode-plugins-official",
          enabled: true,
          scope: "user",
          updateStatus: "update-available",
        },
      }),
      makeActions(),
    );

    expect(html).not.toContain('data-testid="plugin-store-menu-update"');
    expect(html).not.toContain('data-slot="dropdown-menu-separator"');
  });

  it("keeps the separator when other actions precede uninstall", async () => {
    const html = await renderMenu(
      storeItem({ info: { enabled: true } as StorePluginItem["info"] }),
      makeActions({ onSetEnabled: () => {} }),
    );

    expect(html).toContain('data-testid="plugin-store-menu-enabled"');
    expect(html).toContain('data-slot="dropdown-menu-separator"');
  });
});
