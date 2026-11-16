import {
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

/**
 * Live voice-dictation span (specs/voice-dictation.md "Voice text span"): the in-document twin of
 * a running transcription. Every preview update replaces this node's content in place; the
 * finalize step swaps it for a plain TextNode, so restored drafts never contain voice nodes. The
 * committed text lives here; the tentative suffix is a VoiceTentativeTextNode sibling updated
 * alongside. Mode "immutable" keeps the editor from merging neighbour typing into the span.
 */
export class VoiceTextNode extends TextNode {
  static override getType(): string {
    return "voice-text";
  }

  static override clone(node: VoiceTextNode): VoiceTextNode {
    return new VoiceTextNode(node.__text, node.__key);
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.classList.add("zcode-voice-text");
    return dom;
  }

  override updateDOM(prevNode: TextNode, dom: HTMLElement, config: EditorConfig): boolean {
    // TextNode.updateDOM is declared against `this`; the span only ever reuses its own instances.
    const updated = super.updateDOM(prevNode as unknown as this, dom, config);
    if (!dom.classList.contains("zcode-voice-text")) dom.classList.add("zcode-voice-text");
    return updated;
  }

  override canInsertTextBefore(): boolean {
    return false;
  }

  override canInsertTextAfter(): boolean {
    return false;
  }

  override isToken(): boolean {
    // A token node keeps user edits from being typed into the span; the finalize swap is the only
    // writer. Lexical still allows whole-node selection and deletion, which the typing detector
    // treats as a user edit (soft finish).
    return true;
  }
}

/** The volatile tentative suffix shown italic next to the committed voice text. */
export class VoiceTentativeTextNode extends TextNode {
  static override getType(): string {
    return "voice-tentative-text";
  }

  static override clone(node: VoiceTentativeTextNode): VoiceTentativeTextNode {
    return new VoiceTentativeTextNode(node.__text, node.__key);
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.classList.add("zcode-voice-tentative");
    return dom;
  }

  override updateDOM(prevNode: TextNode, dom: HTMLElement, config: EditorConfig): boolean {
    // TextNode.updateDOM is declared against `this`; the span only ever reuses its own instances.
    const updated = super.updateDOM(prevNode as unknown as this, dom, config);
    if (!dom.classList.contains("zcode-voice-tentative"))
      dom.classList.add("zcode-voice-tentative");
    return updated;
  }

  override isToken(): boolean {
    return true;
  }
}

export type SerializedVoiceTextNode = Spread<{ __brand: "voice-text" }, SerializedTextNode>;

/**
 * Creates the committed voice node; pass the previous span's key so an in-place replace keeps the
 * node identity (anchors and history merging survive the update).
 */
export function $createVoiceTextNode(text: string, key?: NodeKey): VoiceTextNode {
  return new VoiceTextNode(text, key);
}

export function $isVoiceTextNode(node: LexicalNode | null | undefined): node is VoiceTextNode {
  return node instanceof VoiceTextNode;
}

export function $isVoiceTentativeTextNode(
  node: LexicalNode | null | undefined,
): node is VoiceTentativeTextNode {
  return node instanceof VoiceTentativeTextNode;
}
