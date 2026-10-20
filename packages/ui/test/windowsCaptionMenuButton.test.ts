import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

const capturedDropdownContentProps = vi.hoisted(() => ({
  calls: [] as Array<{ align?: string; alignOffset?: number }>,
}));

const capturedWindowsCaptionMenu = vi.hoisted(() => {
  const screenshot = {
    dataBase64: "base64-image",
    filename: "zcode-error-2026-06-17.png",
    contentType: "image/png",
    size: 12,
  };

  return {
    screenshot,
    menuItems: [] as Array<{
      label: string;
      onSelect: (() => void | Promise<void>) | undefined;
    }>,
    openSubmit: vi.fn(),
    openFeatureRequest: vi.fn(),
    openExternal: vi.fn(),
    exportLogs: vi.fn(async () => ({ success: true })),
    captureWindowScreenshot: vi.fn(async () => screenshot),
    executeDesktopCommand: vi.fn(async () => undefined),
  };
});

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuCheckboxItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({
    children,
    align,
    alignOffset,
  }: {
    children: ReactNode;
    align?: string;
    alignOffset?: number;
  }) => {
    capturedDropdownContentProps.calls.push({ align, alignOffset });
    return createElement("div", null, children);
  },
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void | Promise<void>;
  }) => {
    const label = Array.isArray(children)
      ? children.filter((child) => typeof child === "string").join("")
      : typeof children === "string"
        ? children
        : "";
    capturedWindowsCaptionMenu.menuItems.push({ label, onSelect });
    return createElement("div", null, children);
  },
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/ui/toast.js", () => ({
  dismissToast: vi.fn(),
  toast: vi.fn(() => 1),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      openSubmit: (draft?: unknown) => void;
      openFeatureRequest: () => void;
    }) => unknown,
  ) =>
    selector({
      openSubmit: capturedWindowsCaptionMenu.openSubmit,
      openFeatureRequest: capturedWindowsCaptionMenu.openFeatureRequest,
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    canOpenCommunity: vi.fn(async () => false),
    captureWindowScreenshot: capturedWindowsCaptionMenu.captureWindowScreenshot,
    executeDesktopCommand: capturedWindowsCaptionMenu.executeDesktopCommand,
    exportLogs: capturedWindowsCaptionMenu.exportLogs,
    openExternal: capturedWindowsCaptionMenu.openExternal,
    openInFileManager: vi.fn(async () => ({ success: true })),
  }),
}));

describe("WindowsCaptionMenuButton", () => {
  async function renderButton(
    triggerPresentation?: "header" | "header-borderless",
    useWindowsCaptionSpacing = false,
  ) {
    capturedDropdownContentProps.calls = [];
    capturedWindowsCaptionMenu.menuItems = [];
    const { WindowsCaptionMenuButton } = await import("@/WindowsCaptionMenuButton.js");
    // Since the shortcut feature, the component reads settings through useShortcutCommandLabel;
    // bare rendering needs a minimal ServiceProvider.
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const { createSettingsTestServices } = await import("./lib/settingsTestServices.js");
    return renderToStaticMarkup(
      createElement(
        ServiceProvider,
        { services: createSettingsTestServices() },
        createElement(WindowsCaptionMenuButton, {
          workspaceAbsPath: "/workspace",
          onCreateTask: vi.fn(),
          onOpenWorkspace: vi.fn(),
          onToggleBrowser: vi.fn(),
          onToggleTerminal: vi.fn(),
          triggerPresentation,
          useWindowsCaptionSpacing,
        }),
      ),
    );
  }

  it("Preview hides the update entry while production keeps it", async () => {
    const { shouldShowDesktopUpdateEntry } = await import("@/WindowsCaptionMenuButton.js");

    // The update entry follows product identity: Preview on the production backend is hidden too.
    expect(shouldShowDesktopUpdateEntry("preview")).toBe(false);
    expect(shouldShowDesktopUpdateEntry("production")).toBe(true);

    const html = await renderButton("header");
    expect(html).not.toContain("titleBar.menu.help.checkForUpdates");
  });

  it("includes help actions migrated from the shared question-mark menu", async () => {
    capturedWindowsCaptionMenu.openSubmit.mockClear();
    capturedWindowsCaptionMenu.openFeatureRequest.mockClear();
    capturedWindowsCaptionMenu.openExternal.mockClear();
    capturedWindowsCaptionMenu.exportLogs.mockClear();
    capturedWindowsCaptionMenu.captureWindowScreenshot.mockClear();

    const html = await renderButton("header");

    expect(html).toContain("titleBar.menu.help.feedback");
    expect(html).toContain("workspaceHeader.help.productRequest");
    expect(html).toContain("workspaceHeader.help.docs");
    expect(html).toContain("titleBar.menu.help.exportLogs");

    await capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "titleBar.menu.help.feedback")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "workspaceHeader.help.productRequest")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "workspaceHeader.help.docs")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "titleBar.menu.help.exportLogs")
      ?.onSelect?.();

    expect(capturedWindowsCaptionMenu.captureWindowScreenshot).not.toHaveBeenCalled();
    expect(capturedWindowsCaptionMenu.openSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bug",
        includeLogs: true,
        screenshots: [],
      }),
    );
    expect(capturedWindowsCaptionMenu.openFeatureRequest).toHaveBeenCalledTimes(1);
    expect(capturedWindowsCaptionMenu.openExternal).toHaveBeenCalledWith("https://zcode.z.ai/docs");
    expect(capturedWindowsCaptionMenu.exportLogs).toHaveBeenCalledTimes(1);
  });

  it("keeps the menu surface clear of the native Windows caption buttons", async () => {
    await renderButton("header");

    // Bugfix: the native Windows titleBarOverlay width has DPI/rounding variance, so the
    // right-aligned menu shifts slightly left to avoid the minimize button.
    expect(capturedDropdownContentProps.calls[0]).toMatchObject({
      align: "end",
      alignOffset: -12,
    });
  });
});
