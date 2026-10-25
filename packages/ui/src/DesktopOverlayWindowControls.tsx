import { DesktopWindowControls } from "@/DesktopWindowControls.js";

/** The full-page overlay covers the workspace window controls; use the root node's platform marker to restore the window controls on Windows/Linux. */
export function DesktopOverlayWindowControls() {
  return (
    <div className="absolute right-1 top-1 z-30 mt-px mr-px hidden h-12 items-center px-2 [app-region:no-drag] platform-windows-desktop:flex platform-linux-desktop:flex">
      <DesktopWindowControls />
    </div>
  );
}
