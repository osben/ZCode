# Web client: desktop-only controls and the sidebar toggle

Fork-owned spec. Covers ISSUE-065 (ZCO-54) and ISSUE-066 (ZCO-55).

## Rules

1. A control that needs the client machine's native apps is shown only when the platform says it can
   run. The capability is `IPlatformService.canOpenLocalFiles`
   (`packages/shared/src/platform.ts`). Desktop sets it to `true`; the web client (plain web and web
   remote control) sets it to `false`. UI never checks `window.zcode` or the user agent to decide
   visibility.
2. The task action menus hide "Open in Finder / File Explorer / file manager" and "Go to config"
   when `canOpenLocalFiles` is not `true`. This applies to every menu built from
   `useTaskListItemContextActions`: the sidebar row dropdown and context menu (`TaskActionMenuContent`),
   the task header "More" menu, the grouped-view context menu, and the Session Manager row menu.
   Wide-screen web remote control hides them too, matching `OpenSplitButton`, which already hides
   native open actions when the capability is false; it no longer opens the folder on the desktop
   host through the platform proxy.
3. The plain web client shows an on-screen sidebar toggle (`desktop-top-logo-sidebar-toggle`'s web
   counterpart, test id `web-top-sidebar-toggle`) in the top-left overlay at every width. It calls
   the same `onToggleSidebar` command as ⌘B, so the sidebar visibility keeps one owner and one write
   path. The web remote control shell keeps its own navigation controls and does not get this
   button.

## Owners

- Capability: the platform service built by each host (`createWebPlatform`, `desktopPlatform`).
- Menu visibility: `useTaskListItemContextActions` returns `canOpenInFileManager`; menus read it.
- Sidebar visibility: unchanged (the existing workspace layout store behind `handleToggleSidebar`).

## Acceptance

- Web (`pnpm dev:web`): no "Open in Finder" or "Go to config" item in any task menu.
- Desktop: both items are still shown and work as before.
- Web at any width, including 390×844: a tappable button in the top-left toggles the sidebar; after
  one tap with the sidebar open, `v4-composer-send` is fully inside the viewport.

## Not covered (needs a product decision)

A full phone layout for the plain web client is out of scope. Options recorded in the ISSUE-065 PR:

- a) Plain web gets a phone layout: the sidebar starts collapsed below `md` and opens as an overlay
  drawer, and the side pane (Review) opens as a full-screen sheet instead of a split.
- b) Phone browsers are sent to the mobile remote control UI (`/remote/v4`), and the plain web
  client declares a minimum supported width.
- c) Only the visible toggle (this spec). The sidebar still opens at its persisted width on phones,
  the Review split can still squeeze the chat, and the header title still truncates.
