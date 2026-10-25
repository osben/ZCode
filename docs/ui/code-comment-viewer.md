# Code Comment Viewer

The code viewer panel supports adding local comments on line ranges, as the interaction entry for later conversation-context capabilities.

## Interaction scope

- Hovering the line-number gutter shows an add-comment button.
- On desktop, hovering / focusing the add-comment button shows a light tooltip to the right of the button, hinting that click or drag is supported; mobile does not depend on hover and a click enters comment input directly.
- Clicking the button adds a comment for a single line; pressing and dragging across other lines selects a contiguous line range.
- After the drag is released, a comment input opens below the last line of the range; the comment text may be empty, and submitting directly passes only the code range as conversation context.
- After submit, the comment preview shows below the last line of the range; deleting the preview does not modify the source file.
- A submitted comment appears as an aggregated chip at the top of the chat input, in the same form as an ordinary attachment.
- Removing the comment chip in the chat input also clears the local preview in the code viewer.
- A comment can be added to the current conversation box from the code viewer of another project; the attachment keeps the source `workspacePath` / `workspaceIdentity` and the full file path.
- After closing a file tab, reopening the same workspace + file path restores comment previews not yet submitted/removed from the preview store in the renderer.

## Implementation boundary

- The current stage delivers the interaction inside the code viewer, the local preview, and the comment attachment display at the top of the composer and in user messages.
- Comments are not written to the source file.
- Comment previews are kept only for the current renderer lifetime; they are not restored after a window refresh or app restart.
- When sending a prompt, the structured prompt tool in `codeCommentContext` is reused to assemble the context; a cross-project comment uses the source workspace information for preview cleanup and does not filter the add event by the current composer's workspace.
- The add-comment button keeps using the built-in gutter utility and `onGutterUtilityClick` of `@pierre/diffs`; the tooltip is enhanced only through unsafeCSS inside the Shadow DOM and `title` / `aria-label`, without switching to a custom `renderGutterUtility`, which would break drag selection of multi-line ranges.

## Layout notes

Ordinary code lines use the line-number column and code column of the parent grid. The comment input/preview must stay fixed inside the visible area during horizontal scrolling, so it uses a sticky inner grid; the inner grid's content column start is aligned by reading the left edge of the real code cell in the parent grid, avoiding misalignment when the digit count of line numbers changes.
