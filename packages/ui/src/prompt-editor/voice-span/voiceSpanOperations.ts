import {
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  $isRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
} from "lexical";
import type { NodeKey, PointType } from "lexical";
import { $createVoiceTextNode, VoiceTentativeTextNode, VoiceTextNode } from "./VoiceTextNode.js";

/**
 * Voice span operations (specs/voice-dictation.md "Voice text span"). Pure Lexical helpers; the
 * editor component owns the mutable span state (node keys) and wraps every call in an
 * editor.update tagged VOICE_SPAN_UPDATE_TAG, which is also how programmatic updates are told
 * apart from user typing.
 */
export interface VoiceSpanState {
  committedKey: NodeKey | null;
  tentativeKey: NodeKey | null;
  /**
   * Draft text the span's creation replaced (a non-collapsed selection at dictation start).
   * Cancel paths and an empty final restore it, so a failed recording never deletes user text.
   */
  replacedText: string | null;
  /**
   * True once a span was created this recording. A finalize with no attached committed node then
   * means the USER deleted the span: the late result is dropped instead of being re-inserted at
   * the caret, which is only correct for recordings that never created a span (one-shot engines).
   */
  created: boolean;
}

export function createVoiceSpanState(): VoiceSpanState {
  return { committedKey: null, tentativeKey: null, created: false, replacedText: null };
}

function attachedNode(key: NodeKey | null): import("lexical").LexicalNode | null {
  if (key === null) return null;
  const node = $getNodeByKey(key);
  return node && node.isAttached() ? node : null;
}

function $charBeforePoint(point: PointType): string {
  if (point.type === "text") {
    return point
      .getNode()
      .getTextContent()
      .charAt(point.offset - 1);
  }
  const sibling = point.getNode().getPreviousSibling();
  return sibling?.getTextContent().slice(-1) ?? "";
}

function $charAfterPoint(point: PointType): string {
  if (point.type === "text") {
    return point.getNode().getTextContent().charAt(point.offset);
  }
  const sibling = point.getNode().getNextSibling();
  return sibling?.getTextContent().charAt(0) ?? "";
}

/** Boundary padding shared with insertEditorPlainTextAtSelection: a space only next to word characters. */
function pad(text: string, before: string, after: string): string {
  const leading = before && !/\s/.test(before) && !text.startsWith(" ") ? " " : "";
  const trailing = after && !/\s/.test(after) && !text.endsWith(" ") ? " " : "";
  return `${leading}${text}${trailing}`;
}

/**
 * Creates the span at the caret on the first update and replaces its content in place afterwards.
 * The insert goes through the range selection (element anchors, text offsets, and selection
 * replacement all handled); without a selection the span joins (or creates) the last paragraph.
 */
export function $updateVoiceSpan(
  preview: { committed: string; tentative: string },
  state: VoiceSpanState,
): void {
  const attachedCommitted = attachedNode(state.committedKey);
  const committed = attachedCommitted instanceof VoiceTextNode ? attachedCommitted : null;
  if (committed === null) {
    const selection = $getSelection();
    const node = $createVoiceTextNode(preview.committed);
    if ($isRangeSelection(selection)) {
      const before = $charBeforePoint(selection.anchor);
      if (before && !/\s/.test(before)) node.setTextContent(` ${preview.committed}`);
      if (!selection.isCollapsed()) state.replacedText = selection.getTextContent();
      selection.insertNodes([node]);
    } else {
      const root = $getRoot();
      const last = root.getLastChild();
      if (last && $isElementNode(last)) {
        last.append(node);
      } else {
        const paragraph = $createParagraphNode();
        paragraph.append(node);
        root.append(paragraph);
      }
    }
    state.committedKey = node.getKey();
    state.created = true;
    if (preview.tentative) {
      const tentative = new VoiceTentativeTextNode(preview.tentative);
      node.insertAfter(tentative);
      state.tentativeKey = tentative.getKey();
    }
    return;
  }
  committed.setTextContent(preview.committed);
  const tentative = attachedNode(state.tentativeKey);
  if (preview.tentative) {
    if (tentative instanceof VoiceTentativeTextNode) {
      tentative.setTextContent(preview.tentative);
    } else {
      const created = new VoiceTentativeTextNode(preview.tentative);
      committed.insertAfter(created);
      state.tentativeKey = created.getKey();
    }
  } else if (tentative instanceof VoiceTentativeTextNode) {
    tentative.remove();
    state.tentativeKey = null;
  }
}

/**
 * Replaces the live span with the final plain text, keeping the neighbour-aware boundary spaces
 * the plain insert path applies. An empty final removes the span. Without a live span the text
 * inserts at the caret like a normal insert; if the user DELETED the span during the recording,
 * the late result is dropped instead.
 */
export function $finalizeVoiceSpan(text: string, state: VoiceSpanState): void {
  const attachedCommitted = attachedNode(state.committedKey);
  const committed = attachedCommitted instanceof VoiceTextNode ? attachedCommitted : null;
  const tentative = attachedNode(state.tentativeKey);
  if (tentative instanceof VoiceTentativeTextNode) tentative.remove();
  state.tentativeKey = null;
  if (committed === null) {
    const userDeletedSpan = state.created;
    state.created = false;
    state.committedKey = null;
    if (userDeletedSpan) {
      // The user removed the span while the recording ran: respect the deletion.
      return;
    }
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      const [start, end] = selection.isBackward()
        ? [selection.focus, selection.anchor]
        : [selection.anchor, selection.focus];
      selection.insertText(pad(text, $charBeforePoint(start), $charAfterPoint(end)));
    } else {
      const plain = $createTextNode(text);
      const root = $getRoot();
      const last = root.getLastChild();
      if (last && $isElementNode(last)) {
        last.append(plain);
      } else {
        const paragraph = $createParagraphNode();
        paragraph.append(plain);
        root.append(paragraph);
      }
    }
    return;
  }
  state.created = false;
  state.committedKey = null;
  if (text === "") {
    // An empty final is a failed recognition: the user's replaced draft comes back.
    restoreReplacedText(committed, state);
    return;
  }
  const previous = committed.getPreviousSibling()?.getTextContent().slice(-1) ?? "";
  const next = committed.getNextSibling()?.getTextContent().charAt(0) ?? "";
  state.replacedText = null;
  committed.replace($createTextNode(pad(text, previous, next)));
}

/** Removes the span (cancel paths); draft text the span replaced comes back in its place. */
export function $cancelVoiceSpan(state: VoiceSpanState): void {
  const attachedCommitted = attachedNode(state.committedKey);
  const tentative = attachedNode(state.tentativeKey);
  if (tentative instanceof VoiceTentativeTextNode) tentative.remove();
  if (attachedCommitted !== null) {
    restoreReplacedText(attachedCommitted, state);
  }
  state.committedKey = null;
  state.tentativeKey = null;
  state.created = false;
}

/** Swaps the committed node for the draft text it replaced (or removes it when nothing was replaced). */
function restoreReplacedText(
  committed: import("lexical").LexicalNode,
  state: VoiceSpanState,
): void {
  const replaced = state.replacedText;
  state.replacedText = null;
  if (replaced === null || replaced === "") {
    committed.remove();
    return;
  }
  committed.replace($createTextNode(replaced));
}
