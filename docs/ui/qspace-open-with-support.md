# QSpace Open With Support

Date: 2026-07-07

## Background

ZCode's "Open with" menu does not enumerate the macOS system Open With list. The desktop main process
maintains a cross-platform external-app candidate list and exposes it to the UI through
`platform.getInstalledEditors()`. QSpace / QSpace Pro installed on macOS were not in the candidates, so they
did not appear in the workspace header, file tree, message file links and preview open menus.

## Scope

- Add QSpace and QSpace Pro to the macOS external-app candidates.
- QSpace / QSpace Pro, as third-party file-manager-class apps, are shown early in the open-with order like
  Finder.
- The open action keeps reusing the existing `platform.openInEditor(editorId, path)` protocol; no protocol
  field is added.

## Non-Goals

- No change to the macOS system default file manager, nor to the existing copy and default semantics of
  "Open in Finder".
- No new local-app open capability in Web, mobile remote or remote workspaces; the remote file tree still
  cannot hand a remote path to local QSpace.
- No change to the realtime/session semantics of `desktop-continuous` and `web-remote-replayable`.

## Implementation Constraints

- The default path of `QSpace.app` is `/Applications/QSpace.app` and of `QSpace Pro.app` is
  `/Applications/QSpace Pro.app`; opening uses the existing macOS `open -a <appPath> <path>` fallback chain.
- Icons keep reusing `getAppIconDataUrl()`, parsed from the app bundle's `Info.plist` and `.icns` resources.
- If the user has not installed a QSpace version, the `existsSync` filter hides that item; with both
  installed, two independent entries show.
