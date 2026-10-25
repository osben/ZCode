# Web Embedded Browser Capability

## Background

The right side pane's "Browser" tab depends on the Electron `webview`, which suits desktop. The Web app and
mobile remote run in an ordinary browser; this version does not support the embedded browser tab and must
not show an entry that would create it.

The project has a similar boundary: on Web, opening a workspace goes through `preferDirectoryBrowser` (a
self-implemented directory picker UI), while desktop keeps the system dialog of
`platform.selectDirectory()`. The browser capability uses the same kind of platform capability boundary
instead of scattered checks in single buttons.

## Goals

- Desktop Electron keeps showing and supporting the right "Browser" tab.
- Web app / mobile remote do not show the "Browser" tab entry.
- The command center does not register browser commands such as `toggle-preview` and `add-browser-tab`.
- A deep browser-tab creation callback in a shell without embedded browser support creates no side pane
  browser tab.
- Ordinary external link clicks still open in a new Web browser tab; this is not the ZCode embedded browser
  feature.

## State Chain

```text
Root platform props
  |
  |-- Desktop: supportsEmbeddedBrowser = true
  |       |
  |       |-- QuickPick registers browser commands
  |       |-- Side pane launcher/menu shows Browser
  |       |-- useAppPanels creates browser side pane tabs
  |
  `-- Web / mobile: supportsEmbeddedBrowser = false
          |
          |-- QuickPick omits browser commands
          |-- Side pane launcher/menu omits Browser
          |-- useAppPanels ignores browser tab creation requests
          `-- URL opening falls back to browser window.open
```

## Impact

- `packages/ui/src/root/types.ts`: Root/App props gain the embedded-browser capability switch.
- `packages/ui/src/App.tsx`: passes the capability to quick pick, the panel hook and the shell layout.
- `packages/ui/src/hooks/useAppPanels.ts`: blocks browser side pane creation when unsupported.
- `packages/ui/src/quickpick/quickPickCommands.ts`: registers commands by capability.
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`: renders the open-tab and plus-menu items by
  capability.
- `packages/web/src/main.tsx`: the Web root entry declares `supportsEmbeddedBrowser={false}` explicitly.

## Verification

Unit tests cover: quick pick shows no browser command without embedded browser support; the side pane
open-tab launcher returns no browser entry without support. Run `pnpm typecheck` and `pnpm lint`.
