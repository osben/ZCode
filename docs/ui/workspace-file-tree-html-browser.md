# File Tree: Open HTML in the Built-in Browser

## Goal

The file tree context menu offers an "open in built-in browser" action for local `.html` / `.htm` files. It
builds a `file://` URL from the file's absolute path and hands it to the existing right Browser side pane.

## Boundary

- Shown only in the local desktop file tree; not shown for remote workspaces, so a remote path is not
  mistaken for a local `file://` file.
- Shown only when the entry type is `file` and the extension is `.html` / `.htm`; not for directories or Git
  deleted virtual files.
- URL generation reuses the UI-layer path utility `toFileUrl()`, so macOS/Linux `file:///...` and Windows
  `file:///C:/...` are both accepted by the built-in browser.
- Opening still goes through `handleOpenBrowserUrl()`; the existing Browser side pane creates the tab,
  validates the URL and navigates, and the file tree never operates the webview directly.

## Verification

`packages/ui/test/workspaceFileTree.test.ts` covers HTML extension recognition and `file://` URL
generation. The change does not touch ZCode session/task realtime, snapshot, queue or
replayable/continuous semantics.
