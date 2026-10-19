/**
 * Geometry for the voice ghost preview (specs/voice-dictation.md, "Ghost preview").
 *
 * The ghost is a plain DOM layer over the editor box, not part of the Lexical document. Its first
 * line starts at the caret through `text-indent`, and its remaining lines wrap across the full
 * editor width. All inputs are viewport coordinates, as returned by getBoundingClientRect.
 */

/** Narrowest room kept for the first ghost line; a caret closer than this to the right edge is pulled left. */
const MIN_FIRST_LINE_PX = 48;

export interface GhostCaretBox {
  left: number;
  top: number;
  height: number;
}

export interface GhostEditorBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GhostLayout {
  /** Top of the ghost text block, relative to the editor box. */
  top: number;
  /** Indent of the first line, relative to the editor box's left edge. */
  indent: number;
}

export function computeGhostLayout({
  caret,
  editor,
  lineHeight,
}: {
  caret: GhostCaretBox;
  editor: GhostEditorBox;
  lineHeight: number;
}): GhostLayout | null {
  if (!(editor.width > 0) || !(editor.height > 0)) return null;
  // Hide while the caret is scrolled out of the editor's visible area; the ghost is clipped to the
  // editor box and would otherwise float over unrelated content.
  const caretTopInEditor = caret.top - editor.top;
  if (
    caretTopInEditor < 0 ||
    caretTopInEditor > editor.height - Math.min(lineHeight, editor.height)
  ) {
    return null;
  }
  const maxIndent = Math.max(0, editor.width - MIN_FIRST_LINE_PX);
  const indent = Math.min(maxIndent, Math.max(0, caret.left - editor.left));
  // The caret glyph box is shorter than the editor's line box; center it inside the line.
  const leading = Math.max(0, (lineHeight - caret.height) / 2);
  return { top: Math.max(0, caretTopInEditor - leading), indent };
}

/** The composer placeholder must yield while ghost text is drawn, otherwise the two overlap on an empty editor. */
export function hasVoicePreviewText(
  preview: { committed: string; tentative: string } | null | undefined,
): boolean {
  return Boolean(preview && (preview.committed.length > 0 || preview.tentative.length > 0));
}
