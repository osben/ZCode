# Local HTML preview external open

## Goal

The desktop local HTML preview card's "open in browser" must hand the file path directly to the OS default application; on failure, tell the user and write a main-process log. Plain `http`/`https` external links keep opening via the system browser URL; Web and remote workspaces keep current behavior. The built-in browser toolbar's 「在默认浏览器中打开」 follows the same constraint for local pages.

## Behavior

- The local desktop HTML card keeps the absolute file path; the menu action calls the path-opening API instead of passing a `file://` URL to `shell.openExternal`.
- The main-process `openExternal` IPC diverts all `file:` URLs: `fileURLToPath` decodes (percent-encoding with Chinese characters and spaces included, stripping hash/query), then `shell.openPath`; this covers entries that take a percent-encoded file URL from `webview.getURL()`, such as the built-in browser toolbar. On conversion failure, log in main and never fall back to `shell.openExternal`.
- Path-open results return `{ success, error? }`; on `success=false` the UI shows an internationalized toast.
- Main logs local-file open success or failure, the path, and the error, so exported logs can pinpoint Windows ShellExecute errors.
- Plain external URLs still use `shell.openExternal`, but rejected promises must be caught and logged so other entries stop failing silently.

## Acceptance

1. Windows absolute paths and paths with Chinese characters and spaces call `shell.openPath`, return success with no error, and never trigger `shell.openExternal`.
2. When `shell.openPath` returns an error or throws, the main-process log contains the error and the HTML card shows a failure toast.
3. `http`/`https` external links and remote HTML cards keep their original open paths.
4. After the built-in browser opens a local HTML with Chinese characters and spaces in the path, the menu's 「在默认浏览器中打开」 opens the decoded local path via `shell.openPath` without triggering `shell.openExternal` (ZCT-202610-8F404D97).
