# Message file links: reveal in file manager

Status: draft 2026-11-02 (user request: the inline file chip in chat messages must always offer "open the folder with the file", with the file selected in the file manager). Owners: `packages/ui/src/components/ai-elements/message.tsx` (`ScopedMessageFileLink` menu), `packages/ui/src/hooks/useFileContextActions.ts` (single UI entry for reveal), `packages/desktop/src/main/desktopMainIpcHelpers.ts` (`openPathInFileManager`, the only OS boundary for this channel).

## Problem

Inline file chips in assistant messages (for example an EPUB the agent just wrote) open a context menu with Open / system applications / Save as / Copy paths — but no way to reveal the file in Finder / Explorer. The workspace file tree and the Git pane do have a reveal entry, and their reveal opens only the containing folder: the file is not selected, so the user still has to find it manually.

## Product rules

1. The message file chip menu always renders a reveal entry ("Open in file manager", `fileActions.revealInFileManager`), in the location block before the copy-path items. It follows the file-tree convention: visible but `disabled` when not allowed, never hidden, so the action is discoverable everywhere.
2. Enabled when the current host can reach a local file manager (`platform.canOpenLocalFiles` and `openInFileManager`) and the workspace is local; remote workspaces keep the existing gating (WSL is the one remote kind that may reveal, through Explorer with a UNC path).
3. Selection semantics — `openInFileManager(path)` on desktop main:
   - regular file → open the containing folder **with the file selected** (`shell.showItemInFolder`; Finder `open -R`, Explorer `/select,`). Passing a file through `shell.openPath` would launch its default application, which is exactly the failure the old "send the directory only" rule guarded against; the guard now lives at the OS boundary instead of every caller.
   - directory → open the folder (unchanged).
   - missing entry (the agent deleted or moved the file after the message was sent) → best-effort open of the parent directory instead of surfacing an OS error.
4. `useFileContextActions.revealInFileManager` passes the target path itself; only WSL keeps resolving to the containing directory, because Explorer needs a folder and main converts it to UNC. Git pane and workspace file tree inherit the file-selection behavior through the same hook — one path, no second helper.
5. Web (no local file manager) keeps the entry disabled; the mobile remote-control proxy uses the same channel and therefore the same selection semantics.

## Acceptance

1. Right-click an inline file chip on desktop → the menu contains "Open in file manager" above "Copy absolute path"; choosing it opens the containing folder with the file highlighted (macOS Finder, Windows Explorer).
2. A chip for a file that no longer exists still opens the containing folder.
3. Remote (non-WSL) workspace → the entry is visible but disabled; local directory chips open the folder without a selection.
4. Git pane / file tree reveal now also selects the file (behavior upgrade, same menu labels).
5. Regression coverage: `packages/desktop/test/desktopMainIpcHelpersOpenExternal.test.ts` asserts file → `shell.showItemInFolder`, directory → folder open, missing → parent folder.
