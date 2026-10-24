# Help Menu What's New

- The desktop Help menu has a `What's New` / `更新日志` entry.
- The main process routes the link by app language: `zh-CN` opens `https://zcode.z.ai/cn/changelog`, other languages open `https://zcode.z.ai/en/changelog`.
- Menu copy lives in `packages/shared/src/desktopMenu.ts`; the click goes through `DesktopCommandIds.OpenChangelog -> desktopCommandHandlers.openChangelog`, keeping URL rules out of the menu template.

## Workspace / Settings help menu

- The workspace header, new-task header, and Settings page share one help ("?") menu component.
- The menu carries the frequent help actions: report a problem, submit a product request, user community, product docs, export logs.
- Export logs does not touch Electron APIs in the UI; it keeps using `IPlatformService.exportLogs()` and the shared toast state, so Desktop / Web fallback boundaries stay consistent.
- Settings places the help entry at the top of the right content panel, reusing the new-task window-button offset so it never overlaps the Windows / Linux custom window controls' hit areas.
- The sidebar footer account menu no longer duplicates problem feedback, community, export logs, or settings entries; the footer keeps the settings gear outside the menu, and the account menu keeps usage, theme, language, zoom, and login actions.
