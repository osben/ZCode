# Write Tool Markdown Preview

> **Current state**: V4 tool rows implement this preview through the shared `ToolCallBlocks` body component.

When a `write` / `create` / `save` tool card shows a file content preview and the target file extension is `.md`, the content is rendered as Markdown. Other text files keep code-block highlighting.

## Interaction Rules

- The Markdown preview reuses the chat message `MessageResponse` renderer and supports headings, lists, code blocks and links.
- Relative links to files inside the workspace still open in the Code Viewer.
- The preview keeps a fixed max height and a scroll container so long documents do not stretch the tool card.

## Entry Points

- `InlineCodeContent` in `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx`
- `inferCodeLanguage` in `packages/ui/src/lib/codeViewer.ts`
