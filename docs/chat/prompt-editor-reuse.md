# Prompt Editor Reuse

Status: `ChatPromptEditor` is used only by the V4 main composer. User-message edit no longer uses an inline editor; it reuses the bottom main composer in edit mode, see [Composer edit mode](../ui/composer-edit-mode.md).

`ChatPromptEditor` is the lightweight shared editor of the chat input. It hosts `LexicalChatInput`, submit/cancel buttons, optional shortcut entries and workspace file drop.

`packages/ui/src/v4/ConversationComposer.tsx` keeps session-level capabilities (toolbar, prompt enhance, attachment selection, stop generation); `ChatPromptEditor` handles only generic editing. When the last message or a queued message is edited, the main composer enters edit mode: the top shows an edit status bar with "Cancel" (UI string "取消"), and "Conversation + file reset" also sits in the status bar; the original message position shows only a "Editing below" placeholder.

Appending a mention by dragging from the workspace file tree is centralized in `workspaceFileComposer`, keeping `@file` mention semantics consistent between edit mode and normal input.
