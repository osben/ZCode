import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import type { VoiceTranscriptionPreview } from "@zcode/services";
import { computeGhostLayout } from "@/lib/voiceGhostPreviewLayout.js";

interface VoiceGhostPreviewProps {
  preview: VoiceTranscriptionPreview | null;
}

interface CaretReading {
  /** Viewport box of the caret (or of the line edge when the caret is between elements). */
  left: number;
  top: number;
  height: number;
  /** The final insertion adds a leading space when the character before the caret is not whitespace. */
  leadingSpace: boolean;
}

interface GhostRender {
  top: number;
  indent: number;
  leadingSpace: boolean;
  font: CSSProperties;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
}

/** Reads the caret from Lexical's selection so the position stays right while the editor is blurred. */
interface CaretPoint {
  key: string;
  type: string;
  offset: number;
  charBefore: string;
}

function readCaretPoint(editor: LexicalEditor): CaretPoint | null {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    // Insertion replaces a selection, so the ghost sits at its start.
    const start = selection.isBackward() ? selection.focus : selection.anchor;
    const text = start.type === "text" ? start.getNode().getTextContent() : "";
    return {
      key: start.key,
      type: start.type,
      offset: start.offset,
      charBefore: start.type === "text" ? text.charAt(start.offset - 1) : "",
    };
  });
}

function readCaret(editor: LexicalEditor, root: HTMLElement): CaretReading | null {
  const point = readCaretPoint(editor);
  if (point) {
    const { key, type, offset, charBefore } = point;
    const element = editor.getElementByKey(key);
    if (element) {
      if (type === "text" && element.firstChild?.nodeType === Node.TEXT_NODE) {
        const textNode = element.firstChild as Text;
        const range = document.createRange();
        range.setStart(textNode, Math.min(offset, textNode.length));
        range.collapse(true);
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        if (rect && rect.height > 0) {
          return {
            left: rect.left,
            top: rect.top,
            height: rect.height,
            leadingSpace: charBefore !== "" && !/\s/.test(charBefore),
          };
        }
      }
      const rect = element.getBoundingClientRect();
      const atStart = offset === 0;
      return {
        left: atStart ? rect.left : rect.right,
        top: rect.top,
        height: rect.height,
        leadingSpace: false,
      };
    }
  }

  // No stored selection: the transcript is appended to the end (see insertEditorPlainTextAtSelection).
  const lastLine = root.lastElementChild;
  if (!lastLine) return null;
  const rect = lastLine.getBoundingClientRect();
  const text = root.textContent ?? "";
  return {
    left: rect.right,
    top: rect.top,
    height: rect.height,
    leadingSpace: text.length > 0 && !/\s$/.test(text),
  };
}

/**
 * Ghost text for the streaming voice preview (specs/voice-dictation.md, "Ghost preview"). The text is
 * a DOM overlay over the editor box: it is never inserted into the Lexical document, so it cannot be
 * submitted, saved in drafts, or added to undo history. The layer is aria-hidden.
 */
export function VoiceGhostPreview({ preview }: VoiceGhostPreviewProps) {
  const [editor] = useLexicalComposerContext();
  const [render, setRender] = useState<GhostRender | null>(null);
  const hasText = Boolean(preview && (preview.committed || preview.tentative));

  const update = useCallback(() => {
    const root = editor.getRootElement();
    if (!root || !hasText) {
      setRender(null);
      return;
    }
    const caret = readCaret(editor, root);
    if (!caret) {
      setRender(null);
      return;
    }
    const style = window.getComputedStyle(root);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const fontSize = parseFloat(style.fontSize) || 14;
    const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5;
    const box = root.getBoundingClientRect();
    const layout = computeGhostLayout({
      caret: { left: caret.left, top: caret.top, height: caret.height },
      editor: {
        left: box.left + paddingLeft,
        top: box.top + paddingTop,
        width: box.width - paddingLeft - paddingRight,
        height: box.height - paddingTop - paddingBottom,
      },
      lineHeight,
    });
    if (!layout) {
      setRender(null);
      return;
    }
    setRender({
      top: layout.top,
      indent: layout.indent,
      leadingSpace: caret.leadingSpace,
      paddingLeft,
      paddingRight,
      paddingTop,
      font: {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight,
      },
    });
  }, [editor, hasText]);

  useLayoutEffect(() => {
    update();
  }, [update, preview]);

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root || !hasText) return;
    const unregister = editor.registerUpdateListener(() => update());
    const onScroll = () => update();
    root.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    observer?.observe(root);
    return () => {
      unregister();
      root.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [editor, hasText, update]);

  if (!preview || !hasText || !render) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="voice-dictation-ghost"
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
    >
      <div
        className="absolute whitespace-pre-wrap break-words text-foreground-subtle"
        style={{
          ...render.font,
          top: render.paddingTop + render.top,
          left: render.paddingLeft,
          right: render.paddingRight,
          textIndent: render.indent,
        }}
      >
        {render.leadingSpace ? " " : null}
        {preview.committed}
        <span className="italic text-foreground-subtlest">{preview.tentative}</span>
      </div>
    </div>
  );
}
