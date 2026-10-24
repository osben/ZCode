# v4 Conversation Detail Parity

This document records the z-code-2 detail regressions that v4 conversation rendering must restore after
the refactor. Scope: renderer / adapter layer only; protocol, runtime, host process, relay and session
stream semantics are unchanged.

## P0 behavior contract

### Tool failure errors are visible

A v4 `ToolCallRow` must keep enough failure information before entering the old `ToolCallBlock` rendering:

```text
ToolCallRow(status=error)
  -> toolCallRowToLegacyNode
  -> TaskChatToolCall(status=failed, error=readable error)
  -> getToolCallErrorText
  -> ToolCallBlock / ToolOutput(error)
```

Error text normalization priority:

1. `row.error.message`
2. a fully wrapped `<tool_use_error>...</tool_use_error>` in `row.output.text`
3. non-empty `row.output.text`
4. `row.error.code`

The legacy `raw` must also keep `rawOutput`, `status=failed`, `v4Status` and the `output.truncated`
reference, so later tool rendering or diagnostics do not lose the root cause again. `cancelled` must not
be shown as a failure error.

### File link right-side detail

Local file links in assistant markdown keep going through the old z-code-2 host dispatch:

```text
MessageResponse file link
  -> onOpenFileLink
  -> WorkspaceShellLayout.handleOpenMarkdownFileLink
      file      -> PreviewPane code viewer
      directory -> WorkspaceFileTree reveal
```

The v4 prop chain must pass from the shell to every row renderer: `V4ChatPane` /
`V4WorkspaceChatArea` -> `SessionPane` -> `ConversationRowRenderContext` ->
`AssistantTextRowView` / `AssistantPreviewCards`. `MessageResponse` still owns hover underline, context
menu and `Open With`; v4 does not reimplement the visual style.

### Windows local file reveal

The right-click "Explorer" action goes through the existing platform/preload IPC into main; for a local
file it calls `shell.showItemInFolder(path)` exactly once (opens the containing directory and selects the
file), and no longer runs `explorer.exe /select` followed by a second open based on the exit code.
Explorer may have delegated the open request and still exit non-zero, so that exit code cannot be the
basis for opening again. A successful return only means the reveal request was issued, not that the
system window has appeared. Windows directories still use `shell.openPath`; macOS Finder, the WSL UNC
branch and mobile remote control keep their existing behavior. Acceptance: a path with Chinese
characters and spaces issues only one reveal request and starts no Explorer child process; on a real
Windows machine right-click shows only the target directory window with the file selected, and no extra
desktop window.

Automatic regression: `openInEditor.test.ts` checks there is no child process call;
`test/e2e/manual-review/pending/windows-file-reveal.test.ts` checks the call count from the real
preload/main IPC to shell (Windows only, mock shell, does not prove the real window count).

## P1 audit list

The following details come from the z-code-2 comparison and are only registered here, not implemented in P0:

- The file target preview priority of an Assistant Preview Card still needs a separate audit so a directory card does not bypass the shell `stat` dispatch.
- The old low-noise tool diagnostics can be used to investigate "task ended but a tool still shows running".
- The suppression of thinking shimmer by a foreground active tool call needs confirmation that v4 is equivalent.
- Mobile `/remote` has no hover, so assistant action visibility needs a separate audit.
- The entry for loading the full tool output of v4 `output.truncated.ref` is still missing.
- The `Error` / `Result` titles of `ToolOutput` are still English text and later need i18n convergence.

## Verification scope

For now UI unit tests prove the projection and callback chain:

- `v4ToolCallRowAdapter.test.ts` covers output-only error, tagged error, code fallback and non-failure states.
- `toolCallBlocks.test.ts` covers the adapted failed node showing the error body in the tool card.
- v4 row / session wiring unit tests cover the file/code/browser open callbacks entering `MessageResponse` and tool rows.

A formal WDIO E2E can add a `VDP` group later, using a replay fixture to build a failed tool row and a
markdown local file link and asserting that the right pane / file tree really opens.
