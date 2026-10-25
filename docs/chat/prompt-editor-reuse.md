# Prompt Editor Reuse

Status: `ChatPromptEditor` is shared by the V4 main composer and the V4 user-message edit state.

`ChatPromptEditor` is the lightweight shared editor of the chat input. It hosts `LexicalChatInput`, submit/cancel buttons, optional shortcut entries and workspace file drop. The main input area and the user-message edit state both reuse the input core through it.

`packages/ui/src/v4/ConversationComposer.tsx` keeps session-level capabilities (toolbar, prompt enhance, attachment selection, stop generation); `ChatPromptEditor` handles only generic editing. User-message edit is done by `packages/ui/src/v4/ConversationRowView.tsx`, which replaces the original bubble inline with the same editor and shows only original-text editing, cancel, submit, read-only attachment display and file mention drop insertion.

Appending a mention by dragging from the workspace file tree is centralized in `workspaceFileComposer`, so the main composer and the edit composer do not each assemble markdown, keeping `@file` mention semantics consistent.
