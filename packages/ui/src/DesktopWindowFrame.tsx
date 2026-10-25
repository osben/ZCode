import { memo, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

export const DesktopWindowFrame = memo(function DesktopWindowFrameComponent({
  title: _title,
  children,
  actions: _actions,
  tabBar: _tabBar,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  headerTestId: _headerTestId,
  showHeader: _showHeader = isDesktop,
}: {
  title: string;
  children: ReactNode;
  topBar?: ReactNode;
  actions?: ReactNode;
  /** Tab-bar slot rendered after the title inside the header. */
  tabBar?: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  headerTestId?: string;
  showHeader?: boolean;
}) {
  const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
  const usesOpaqueRootSurface = !isDesktop || isWindowsDesktop || isLinuxDesktop;

  return (
    <div
      className={cn(
        // On mobile browsers, 100vh includes the address-bar area in the page height,
        // which can push the remote-control page’s bottom input outside the viewport. Dynamic viewport height follows browser chrome changes without affecting the desktop appearance.
        "flex h-dvh flex-col overflow-hidden border-border text-foreground",
        // The opaque background of a Linux BrowserWindow restores square corners to the outermost layer.
        // The 16px shell, 12px inner panel, and 4px inset form concentric corners. During native dragging/resizing, the Linux compositor may briefly lose overflow rounding,
        // so use a matching clip-path to keep compositing clipped; both radii return to zero when maximized.
        isLinuxDesktop &&
          "rounded-[16px] [clip-path:inset(0_round_16px)] platform-linux-window-maximized:rounded-none platform-linux-window-maximized:[clip-path:inset(0)]",
        // Web, Windows, and Linux do not have macOS vibrancy as a transparent-layer fallback.
        // Continuing to use a translucent alt background would blend with the browser or system window background into an unintended gray block.
        usesOpaqueRootSurface ? "bg-background-win-alt" : "bg-background-alt",
      )}
      data-desktop-window-frame="true"
    >
      <div className="relative flex-1 min-h-0 w-full">{children}</div>
    </div>
  );
});
