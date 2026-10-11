import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";
import { PluginUiFollowUpDialogHost } from "@/plugin-ui/index.js";

export function RootShell({ children }: { children: ReactNode }) {
  // Web remote control cannot use fixed 100vh in mobile browsers,
  // because showing/hiding the address bar can clip the bottom input area outside the viewport; use dynamic viewport height on the root.
  return (
    <div className="relative h-dvh">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
      <PluginUiFollowUpDialogHost />
    </div>
  );
}
