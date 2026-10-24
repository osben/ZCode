# Sidebar Footer Log Export

## Goal

The bottom-left account menu gets an "Export logs" entry, so users can export a diagnostic bundle without
going into the Windows title bar menu or the system menu.

## Behavior

- The entry sits in the account menu's support action area, in the same group as "问题反馈" (Feedback) and
  "用户社群" (User community).
- Menu copy reuses the Windows menu's `titleBar.menu.help.exportLogs`; toast copy reuses the existing
  `sidebar.exportLogs.pending` and `sidebar.exportLogs.error`.
- Clicking reuses `platform.exportLogs()`; the desktop main packages the logs and reveals the export result in
  the system file browser.
- Web keeps using the platform-layer fallback and shows an error toast when unsupported, adding no
  desktop-only branch.

## Implementation Locations

- Menu entry: `packages/ui/src/WorkspaceSidebarFooter.tsx`
- Shared action: `packages/ui/src/lib/exportLogsAction.ts`
- The Windows title bar menu reuses the same action: `packages/ui/src/WindowsCaptionMenuButton.tsx`
