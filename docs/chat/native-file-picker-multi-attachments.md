# Native file picker multi-attachment spec

The chat composer attachment model supports multiple attachments, and Web file input and drag-and-drop can add several files at once. The desktop native file picker, however, returns a single local path through `selectFile()`, so the attachment button added one file at a time.

## Goals

- The desktop composer's native file picker selects multiple files at once.
- The existing attachment cap `MAX_CHAT_ATTACHMENTS = 8` stays; when selections exceed the remaining slots, the existing truncation and hint behavior applies.
- `selectFile()` keeps its single-file semantics for single-file scenarios such as SSH private keys.
- Web, mobile remote and drag-and-drop attachment entry behavior is unchanged.

## Design

- The platform layer adds `selectFiles(): Promise<string[]>`, which only means "select multiple local absolute paths the agent can access".
- The Desktop main process adds a matching IPC handler; Electron `showOpenDialog` uses `["openFile", "multiSelections"]` and returns an empty array on cancel.
- Desktop preload / renderer platform expose `selectFiles()`.
- When `canSelectFilePath` is true the composer prefers `selectFiles()`; if an older host lacks it, fall back to `selectFile()`.
- Each returned path reuses the existing `createChatComposerPathAttachment` and `addPreparedAttachments`; no new attachment model.

## Non-goals

- Single-file / single-directory pickers (remote connection form, private key, directory selection) are unchanged.
- Web `<input type="file" multiple>` and drag-and-drop attachment parsing are unchanged.
- The attachment cap is not raised.
