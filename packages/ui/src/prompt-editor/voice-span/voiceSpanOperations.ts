import {
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from "lexical";
import type { NodeKey } from "lexical";
import { $createVoiceTextNode, VoiceTextNode, VoiceTentativeTextNode } from "./VoiceTextNode.js";

/**
 * Voice span operations (specs/voice-dictation.md "Voice text span"). Pure Lexical helpers; the
 * editor component owns the mutable span state (node keys) and wraps every call in an
 * editor.update tagged VOICE_SPAN_UPDATE_TAG, which is also how programmatic updates are told
 * apart from user typing.
 */
export interface VoiceSpanState {
  committedKey: NodeKey | null;
  tentativeKey: NodeKey | null;
}

/** Returns the attached node for a span key, or null when it was removed (stale key). */
function attachedNode(key: NodeKey | null): import("lexical").LexicalNode | null {
  if (key === null) return null;
  const node = $getNodeByKey(key);
  return node && node.isAttached() ? node : null;
}

/**
 * Creates the span at the caret on the first update and replaces its content in place afterwards.
 * The committed node keeps its key; the tentative suffix node exists only while tentative text is
 * non-empty.
 */
export function $updateVoiceSpan(
  preview: { committed: string; tentative: string },
  state: VoiceSpanState,
): void {
  const attachedCommitted = attachedNode(state.committedKey);
  const committed = attachedCommitted instanceof VoiceTextNode ? attachedCommitted : null;
  if (committed === null) {
    const selection = $getSelection();
    const anchor = $isRangeSelection(selection)
      ? selection.isBackward()
        ? selection.focus
        : selection.anchor
      : null;
    const node = $createVoiceTextNode(preview.committed);
    if (anchor) {
      anchor.getNode().insertAfter(node);
    } else {
      // Text nodes cannot sit at the root: without a selection the span joins (or creates) the
      // last paragraph, matching where a plain insert would land.
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
 * Replaces the live span with the final plain text; an empty final removes it. Without a live
 * span (one-shot engines never streamed) the text inserts at the caret like a normal insert,
 * keeping today's finalize behaviour.
 */
export function $finalizeVoiceSpan(text: string, state: VoiceSpanState): void {
  const attachedCommitted = attachedNode(state.committedKey);
  const committed = attachedCommitted instanceof VoiceTextNode ? attachedCommitted : null;
  const tentative = attachedNode(state.tentativeKey);
  if (tentative instanceof VoiceTentativeTextNode) tentative.remove();
  state.tentativeKey = null;
  if (committed === null) {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.insertText(text);
    } else {
      const root = $getRoot();
      const last = root.getLastChild();
      const plain = $createTextNode(text);
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
  if (text === "") {
    committed.remove();
  } else {
    committed.replace($createTextNode(text));
  }
  state.committedKey = null;
}

/** Removes the span without inserting anything (cancel paths). */
export function $cancelVoiceSpan(state: VoiceSpanState): void {
  const attachedCommitted = attachedNode(state.committedKey);
  const tentative = attachedNode(state.tentativeKey);
  if (tentative instanceof VoiceTentativeTextNode) tentative.remove();
  if (attachedCommitted !== null) attachedCommitted.remove();
  state.committedKey = null;
  state.tentativeKey = null;
}
