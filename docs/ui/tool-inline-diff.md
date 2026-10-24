# Tool Inline Diff

> Current state: V4 tool rows render through `ToolCallBlocks`; chat inline diff uses a lightweight
> highlighted preview, and the full Diff Viewer keeps full diff rendering.

## Background

File-modifying tools in the chat area used to show only parameters and raw output, so the user had to open
the code viewer to see the real diff. The minimal version:

- handles only `edit` / `patch` tools that can produce a patch preview;
- renders a unified diff inline in the tool card, using a lightweight, asynchronously highlighted unified
  diff to avoid mounting a large Shadow DOM on the chat main thread;
- keeps the "View Diff" button as a fallback entry.

## Current Implementation

Entry: `packages/ui/src/ToolCallBlocks/renderers/edit.tsx` and
`packages/ui/src/ToolCallBlocks/renderers/EditInlineDiffContent.tsx`.

- `getToolCallCodePreview()` decides whether the tool can produce a `patch` preview.
- For `edit` tools such as `opencode`, prefer parsing the standard `diff` block in `raw.content`.
- An ordinary tool call first renders as a compact collapsed row "status + tool title + optional summary",
  with raw content collapsed by default; the running state uses shimmer status text, and a finished state
  shows the expand arrow on the right only on hover / focus.
- On a `patch` hit the expanded content uses `HighlightedLightweightDiffPreview`, with no extra parameters
  or raw JSON output.
- The "View Diff" button remains but appears only after the user opens the tool call.

## Known Boundaries

- It currently consumes structured file summary, patch preview and old snapshot/provider compatibility
  data; compatibility inference stays in the UI display layer.
- Only unified diff is supported, not side-by-side; only patch / before-after structures that `codeViewer`
  already recognizes are handled.
- The tool call summary is currently derived only from the string / `command` / `path` / `prompt` of
  `input`, with no tool-specific fields yet.

## Possible Follow-Ups

Add the structured diff type to `@zcode/shared`; unify parsing of ZCode standard `toolContent` in the
services layer; add side-by-side diff and location follow-along.
