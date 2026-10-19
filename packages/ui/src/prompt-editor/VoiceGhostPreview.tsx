import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import type { VoiceTranscriptionPreview } from "@zcode/services";
import { computeGhostLayout, hasVoicePreviewText } from "@/lib/voiceGhostPreviewLayout.js";

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

/** Editor box metrics copied from computed style. Reused across caret updates until a resize. */
interface GhostMetrics {
  font: CSSProperties;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  lineHeight: number;
}

interface GhostRender {
  top: number;
  indent: number;
  leadingSpace: boolean;
  metrics: GhostMetrics;
}

function readMetrics(root: HTMLElement): GhostMetrics {
  const style = window.getComputedStyle(root);
  const fontSize = parseFloat(style.fontSize) || 14;
  return {
    font: {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      lineHeight: style.lineHeight,
    },
    paddingLeft: parseFloat(style.paddingLeft) || 0,
    paddingRight: parseFloat(style.paddingRight) || 0,
    paddingTop: parseFloat(style.paddingTop) || 0,
    paddingBottom: parseFloat(style.paddingBottom) || 0,
    lineHeight: parseFloat(style.lineHeight) || fontSize * 1.5,
  };
}

function sameRender(previous: GhostRender | null, next: GhostRender): boolean {
  return (
    previous !== null &&
    previous.top === next.top &&
    previous.indent === next.indent &&
    previous.leadingSpace === next.leadingSpace &&
    previous.metrics === next.metrics
  );
}

function readCaret(editor: LexicalEditor, root: HTMLElement): CaretReading | null {
  // Read from Lexical's selection so the position stays right while the editor is blurred.
  const point = editor.getEditorState().read(() => {
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

  // No stored selection: the transcript is appended after the last child of the last paragraph
  // (see $appendPlainText in LexicalChatInput.tsx). Measure that append point, not the paragraph box:
  // the box's right edge and top are not where the text goes when the paragraph wraps.
  const lastParagraph = root.lastElementChild;
  if (!lastParagraph) return null;
  const text = root.textContent ?? "";
  const leadingSpace = text.length > 0 && !/\s$/.test(text);
  const lastChild = lastParagraph.lastChild;
  // Empty paragraph (its DOM holds at most a placeholder line break): the append point is its start edge.
  if (!lastChild || lastParagraph.textContent === "") {
    const rect = lastParagraph.getBoundingClientRect();
    return { left: rect.left, top: rect.top, height: rect.height, leadingSpace };
  }
  // Collapsed range right after the last child; a trailing mention or line break is a single child,
  // so the range sits after it rather than inside it.
  const range = document.createRange();
  range.setStartAfter(lastChild);
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect && rect.height > 0) {
    return { left: rect.left, top: rect.top, height: rect.height, leadingSpace };
  }
  // Some engines report no box for a collapsed range at an element boundary; use the paragraph's line.
  const box = lastParagraph.getBoundingClientRect();
  return { left: box.left, top: box.top, height: box.height, leadingSpace };
}

/**
 * Ghost text for the streaming voice preview (specs/voice-dictation.md, "Ghost preview"). The text is
 * a DOM overlay over the editor box: it is never inserted into the Lexical document, so it cannot be
 * submitted, saved in drafts, or added to undo history. The layer is aria-hidden.
 */
export function VoiceGhostPreview({ preview }: VoiceGhostPreviewProps) {
  const [editor] = useLexicalComposerContext();
  const [render, setRender] = useState<GhostRender | null>(null);
  const hasText = hasVoicePreviewText(preview);
  /** Null means "read again": cleared when the ghost hides and on every resize. */
  const metricsRef = useRef<GhostMetrics | null>(null);
  const frameRef = useRef<number | null>(null);

  const update = useCallback(() => {
    const root = editor.getRootElement();
    if (!root || !hasText) {
      metricsRef.current = null;
      setRender(null);
      return;
    }
    const caret = readCaret(editor, root);
    if (!caret) {
      setRender(null);
      return;
    }
    if (!metricsRef.current) metricsRef.current = readMetrics(root);
    const metrics = metricsRef.current;
    const box = root.getBoundingClientRect();
    const layout = computeGhostLayout({
      caret: { left: caret.left, top: caret.top, height: caret.height },
      editor: {
        left: box.left + metrics.paddingLeft,
        top: box.top + metrics.paddingTop,
        width: box.width - metrics.paddingLeft - metrics.paddingRight,
        height: box.height - metrics.paddingTop - metrics.paddingBottom,
      },
      lineHeight: metrics.lineHeight,
    });
    if (!layout) {
      setRender(null);
      return;
    }
    const next: GhostRender = {
      top: layout.top,
      indent: layout.indent,
      leadingSpace: caret.leadingSpace,
      metrics,
    };
    // Keep the previous object when nothing visible changed, so React skips the re-render.
    setRender((previous) => (sameRender(previous, next) ? previous : next));
  }, [editor, hasText]);

  /** Lexical updates, scrolls and resizes arrive in bursts; they collapse into one frame. */
  const scheduleUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      update();
    });
  }, [update]);

  // Preview changes are synchronous so the ghost never paints with a stale preview.
  useLayoutEffect(() => {
    update();
  }, [update, preview]);

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root || !hasText) return;
    const unregister = editor.registerUpdateListener(() => scheduleUpdate());
    const onScroll = () => scheduleUpdate();
    root.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            metricsRef.current = null;
            scheduleUpdate();
          });
    observer?.observe(root);
    return () => {
      unregister();
      root.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [editor, hasText, scheduleUpdate]);

  if (!preview || !render) return null;
  const { metrics } = render;
  return (
    <div
      aria-hidden="true"
      data-testid="voice-dictation-ghost"
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
    >
      <div
        className="absolute whitespace-pre-wrap break-words text-foreground-subtle"
        style={{
          ...metrics.font,
          top: metrics.paddingTop + render.top,
          left: metrics.paddingLeft,
          right: metrics.paddingRight,
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
