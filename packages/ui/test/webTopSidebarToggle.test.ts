// @vitest-environment jsdom
// ISSUE-065: the plain web client had no on-screen sidebar toggle at any width (only ⌘B),
// so a touch phone could not collapse the sidebar to reach the composer.
import { createElement, type ComponentProps, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";

vi.mock("@/ControlHintTooltip.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ControlHintTooltip.js")>()),
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/UpdateStatusButton.js", () => ({ UpdateStatusButton: () => null }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(cleanup);

type OverlayProps = ComponentProps<typeof DesktopTopOverlay>;

function renderOverlay(overrides: Partial<OverlayProps>) {
  const onToggleSidebar = vi.fn();
  render(
    createElement(DesktopTopOverlay, {
      workspaceAbsPath: "/repo",
      isSidebarVisible: true,
      updateReadyVersion: null,
      updateState: null,
      toggleSidebarShortcutLabel: "Ctrl+B",
      newTaskShortcutLabel: "Ctrl+N",
      goBackShortcutLabel: "Alt+Left",
      goForwardShortcutLabel: "Alt+Right",
      canTaskNavBack: false,
      canTaskNavForward: false,
      canGoBack: false,
      canGoForward: false,
      appLogoUrl: "/logo.svg",
      platform: {} as OverlayProps["platform"],
      onToggleSidebar,
      onCreateTask: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      ...overrides,
    }),
  );
  return { onToggleSidebar };
}

describe("web top sidebar toggle", () => {
  it.each([true, false])(
    "plain web shows a toggle that runs the shared sidebar command (sidebar visible: %s)",
    (isSidebarVisible) => {
      const { onToggleSidebar } = renderOverlay({
        isDesktop: false,
        isSidebarVisible,
        showWebSidebarToggle: true,
      });

      fireEvent.click(screen.getByTestId("web-top-sidebar-toggle"));
      expect(onToggleSidebar).toHaveBeenCalledExactlyOnceWith();
      expect(screen.queryByTestId("desktop-top-logo-sidebar-toggle")).toBeNull();
    },
  );

  it("is absent when the shell does not ask for it (web remote control)", () => {
    renderOverlay({ isDesktop: false });

    expect(screen.queryByTestId("web-top-sidebar-toggle")).toBeNull();
  });

  it.each([
    { name: "Windows", isWindowsDesktop: true, isMacDesktop: false },
    { name: "Linux", isWindowsDesktop: false, isMacDesktop: false },
    { name: "macOS", isWindowsDesktop: false, isMacDesktop: true },
  ])("$name desktop keeps its own toggle and never renders the web one", (platformFlags) => {
    renderOverlay({ isDesktop: true, showWebSidebarToggle: true, ...platformFlags });

    expect(screen.queryByTestId("web-top-sidebar-toggle")).toBeNull();
  });
});
