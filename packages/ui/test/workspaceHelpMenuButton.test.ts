import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";
import { TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER } from "@zcode/shared/test-ids";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

const captured = vi.hoisted(() => ({
  zsrcUrl: null as string | null,
  loading: false,
  openExternal: vi.fn(),
  exportLogs: vi.fn(async () => ({ success: true })),
  toast: vi.fn(() => 7),
  dismissToast: vi.fn(),
  menuItems: [] as Array<{
    label: string;
    testId?: string;
    disabled?: boolean;
    onSelect: (() => void | Promise<void>) | undefined;
  }>,
  updateMenu: {
    visible: true,
    disabled: false,
    labelId: "titleBar.menu.help.checkForUpdates",
    labelValues: undefined,
  },
  executeDesktopCommand: vi.fn(async () => undefined),
  getDeviceId: vi.fn(() => "device-mid-123"),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void | Promise<void>;
    disabled?: boolean;
    "data-testid"?: string;
  }) => {
    const label = Array.isArray(children)
      ? children.filter((child) => typeof child === "string").join("")
      : typeof children === "string"
        ? children
        : "";
    captured.menuItems.push({ label, testId, onSelect, disabled });
    return createElement("div", { "data-testid": testId }, children);
  },
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: captured.toast,
  dismissToast: captured.dismissToast,
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      openSubmit: (draft?: unknown) => void;
      openFeatureRequest: () => void;
    }) => unknown,
  ) => selector({ openSubmit: vi.fn(), openFeatureRequest: vi.fn() }),
}));

vi.mock("@/hooks/useDesktopUpdateMenu.js", () => ({
  useDesktopUpdateMenu: (isDesktop: boolean) => ({
    ...captured.updateMenu,
    visible: isDesktop && captured.updateMenu.visible,
    checkForUpdates: () => captured.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    captureWindowScreenshot: vi.fn(async () => null),
    executeDesktopCommand: captured.executeDesktopCommand,
    exportLogs: captured.exportLogs,
    getDeviceId: captured.getDeviceId,
    openCommunity: vi.fn(async () => undefined),
    openExternal: captured.openExternal,
  }),
}));

vi.mock("@/hooks/useVulnerabilityReportUrl.js", () => ({
  useVulnerabilityReportUrl: () => ({
    url: captured.zsrcUrl,
    loading: captured.loading,
  }),
}));

describe("WorkspaceHelpMenuButton", () => {
  async function render(isDesktop: boolean | undefined) {
    captured.menuItems = [];
    captured.executeDesktopCommand.mockClear();
    captured.exportLogs.mockClear();
    captured.toast.mockClear();
    captured.dismissToast.mockClear();
    const { WorkspaceHelpMenuButton } = await import("@/WorkspaceHelpMenuButton.js");
    return renderToStaticMarkup(createElement(WorkspaceHelpMenuButton, { isDesktop }));
  }

  it("desktop and Web show the vulnerability entry right after issue report, opening the configured URL; hidden when absent", async () => {
    for (const desktop of [true, false]) {
      captured.zsrcUrl = "https://security.example.test/report";
      captured.openExternal.mockClear();
      try {
        await render(desktop);
        const index = captured.menuItems.findIndex(
          (item) => item.label === "workspaceHeader.help.reportVulnerability",
        );
        expect(index).toBeGreaterThan(0);
        expect(captured.menuItems[index - 1]?.label).toBe("workspaceHeader.help.issueReport");
        await captured.menuItems[index]?.onSelect?.();
        expect(captured.openExternal).toHaveBeenCalledExactlyOnceWith(captured.zsrcUrl);
      } finally {
        captured.zsrcUrl = null;
      }
      expect(await render(desktop)).not.toContain("workspaceHeader.help.reportVulnerability");
    }
  });

  it("a cold-cache loading entry cannot trigger the external link and keeps its position and copy once a valid config arrives", async () => {
    captured.loading = true;
    captured.openExternal.mockClear();
    try {
      await render(true);
      const before = captured.menuItems.map((item) => item.label);
      const item = captured.menuItems.find(
        (item) => item.label === "workspaceHeader.help.reportVulnerability",
      );
      expect(item).toMatchObject({ disabled: true, onSelect: undefined });
      captured.loading = false;
      captured.zsrcUrl = "https://security.example.test/report";
      await render(true);
      expect(captured.menuItems.map((item) => item.label)).toEqual(before);
      expect(
        captured.menuItems.find((item) => item.label === "workspaceHeader.help.reportVulnerability")
          ?.disabled,
      ).toBe(false);
      expect(captured.openExternal).not.toHaveBeenCalled();
    } finally {
      captured.loading = false;
      captured.zsrcUrl = null;
    }
  });

  it("desktop renders the resource manager entry and clicking it runs the OpenResourceManager command", async () => {
    // Reason: Windows/Linux have no native menu bar and the custom arrow menu is gone; the help menu is the only resource manager entry.
    const html = await render(true);

    expect(html).toContain("titleBar.menu.help.resourceManager");
    const item = captured.menuItems.find(
      (entry) => entry.testId === TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
    );
    expect(item).toBeDefined();
    await item!.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.OpenResourceManager,
    );
  });

  it("Web (isDesktop undefined / false) does not render the resource manager entry", async () => {
    for (const isDesktop of [undefined, false]) {
      const html = await render(isDesktop);
      expect(html).not.toContain("titleBar.menu.help.resourceManager");
      expect(
        captured.menuItems.some(
          (entry) => entry.testId === TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
        ),
      ).toBe(false);
    }
  });

  it("desktop puts About last and clicking it reuses ShowAbout", async () => {
    await render(true);
    const index = captured.menuItems.findIndex(
      (entry) => entry.label === "titleBar.menu.help.about",
    );
    expect(index).toBeGreaterThan(0);
    expect(index).toBe(captured.menuItems.length - 1);
    await captured.menuItems[index]?.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
      DesktopCommandIds.ShowAbout,
    );
  });

  it("Web and mobile remote control hide the desktop About entry", async () => {
    for (const isDesktop of [undefined, false]) {
      expect(await render(isDesktop)).not.toContain("titleBar.menu.help.about");
    }
  });

  it("Check for updates follows the resource manager and clicking it runs the existing command", async () => {
    await render(true);
    const index = captured.menuItems.findIndex(
      (entry) => entry.label === "titleBar.menu.help.checkForUpdates",
    );
    expect(index).toBeGreaterThan(0);
    expect(captured.menuItems[index - 1]?.testId).toBe(TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER);
    await captured.menuItems[index]?.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
      DesktopCommandIds.CheckForUpdates,
    );
  });

  it("Web and Preview hide Check for updates", async () => {
    expect(await render(false)).not.toContain("titleBar.menu.help.checkForUpdates");
    captured.updateMenu.visible = false;
    try {
      expect(await render(true)).not.toContain("titleBar.menu.help.checkForUpdates");
    } finally {
      captured.updateMenu.visible = true;
    }
  });

  it("desktop export logs reuses the platform export and the shared toast", async () => {
    await render(true);
    const item = captured.menuItems.find(
      (entry) => entry.label === "titleBar.menu.help.exportLogs",
    );
    expect(item).toBeDefined();
    await item!.onSelect?.();
    expect(captured.exportLogs).toHaveBeenCalledExactlyOnceWith();
    expect(captured.toast).toHaveBeenCalledWith("sidebar.exportLogs.pending", {
      durationMs: Number.POSITIVE_INFINITY,
    });
    expect(captured.dismissToast).toHaveBeenCalledWith(7);
  });

  it("desktop copy device MID writes the platform device id to the clipboard and shows the success toast", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await render(true);
      const item = captured.menuItems.find(
        (entry) => entry.label === "workspaceHeader.help.copyDeviceMid",
      );
      expect(item).toBeDefined();
      await item!.onSelect?.();
      expect(writeText).toHaveBeenCalledExactlyOnceWith("device-mid-123");
      expect(captured.toast).toHaveBeenCalledWith("workspaceHeader.help.deviceMidCopied");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("copy device MID shows the failure toast when the clipboard rejects or is unavailable", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await render(true);
      const item = captured.menuItems.find(
        (entry) => entry.label === "workspaceHeader.help.copyDeviceMid",
      );
      await item!.onSelect?.();
      expect(captured.toast).toHaveBeenCalledWith("workspaceHeader.help.deviceMidCopyFailed");
      expect(captured.toast).not.toHaveBeenCalledWith("workspaceHeader.help.deviceMidCopied");
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("navigator", {});
    try {
      captured.toast.mockClear();
      await render(true);
      const item = captured.menuItems.find(
        (entry) => entry.label === "workspaceHeader.help.copyDeviceMid",
      );
      await item!.onSelect?.();
      expect(captured.getDeviceId).toHaveBeenCalled();
      expect(captured.toast).toHaveBeenCalledWith("workspaceHeader.help.deviceMidCopyFailed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Web hides copy device MID", async () => {
    for (const isDesktop of [undefined, false]) {
      expect(await render(isDesktop)).not.toContain("workspaceHeader.help.copyDeviceMid");
    }
  });

  it("Web and mobile remote control hide the local export-logs entry", async () => {
    for (const isDesktop of [undefined, false]) {
      expect(await render(isDesktop)).not.toContain("titleBar.menu.help.exportLogs");
      expect(captured.exportLogs).not.toHaveBeenCalled();
    }
  });

  it("desktop gets one separator between the two groups with export logs first in the desktop group; Web keeps only the help group", async () => {
    for (const desktop of [true, false]) {
      const html = await render(desktop);
      expect(captured.menuItems.map((item) => item.label)).toEqual([
        "workspaceHeader.help.docs",
        "workspaceHeader.help.community",
        "workspaceHeader.help.issueReport",
        "workspaceHeader.help.productRequest",
        ...(desktop
          ? [
              "titleBar.menu.help.exportLogs",
              "workspaceHeader.help.copyDeviceMid",
              "titleBar.menu.help.resourceManager",
              "titleBar.menu.help.checkForUpdates",
              "titleBar.menu.help.about",
            ]
          : []),
      ]);
      expect((html.match(/<hr/g) ?? []).length).toBe(desktop ? 1 : 0);
    }
  });

  it("desktop and Web keep the existing help entries", async () => {
    for (const isDesktop of [true, false]) {
      const html = await render(isDesktop);
      for (const id of [
        "workspaceHeader.help.issueReport",
        "workspaceHeader.help.productRequest",
        "workspaceHeader.help.community",
        "workspaceHeader.help.docs",
      ]) {
        expect(html).toContain(id);
      }
    }
  });
});
