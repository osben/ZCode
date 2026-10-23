/**
 * Serialized prompt bodies (quick prompts store `body_markdown` plus `body_nodes`).
 *
 * The nodes are the Lexical JSON of the root's top-level paragraphs, so mention chips survive a round trip.
 * Markdown-to-mention parsing is deliberately absent: a markdown body would flatten mention nodes.
 * This file must not import the editor components, so the slash plugin and the editor can both use it.
 */
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  type LexicalNode,
  type PointType,
  type RangeSelection,
  type SerializedLexicalNode,
} from "lexical";
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";

export interface SerializedPromptBody {
  markdown: string;
  nodes: string;
}

/**
 * Lexical's ElementNode.exportJSON() returns empty children; the tree must be walked explicitly, or inline mention
 * chips and text would be lost from the stored body.
 */
function $exportNodeTree(node: LexicalNode): SerializedLexicalNode {
  const json = node.exportJSON() as SerializedLexicalNode & { children?: SerializedLexicalNode[] };
  if ($isElementNode(node)) json.children = node.getChildren().map($exportNodeTree);
  return json;
}

/** Must run inside an editor read or update. */
export function $readSerializedPromptBody(): SerializedPromptBody {
  const root = $getRoot();
  return {
    markdown: $getPromptMarkdown(root),
    nodes: JSON.stringify(root.getChildren().map($exportNodeTree)),
  };
}

/** Throws on malformed JSON so a broken stored body is never inserted partially. */
export function parseSerializedPromptBodyNodes(nodesJson: string): SerializedLexicalNode[] {
  const parsed: unknown = JSON.parse(nodesJson);
  if (!Array.isArray(parsed)) throw new Error("serialized prompt body must be a JSON array");
  return parsed as SerializedLexicalNode[];
}

function paragraphChildren(paragraph: SerializedLexicalNode): SerializedLexicalNode[] {
  const children = (paragraph as { children?: unknown }).children;
  return Array.isArray(children) ? (children as SerializedLexicalNode[]) : [];
}

function $textBeforePoint(point: PointType): string {
  if (point.type !== "text") return "";
  const node = point.getNode();
  return $isTextNode(node) ? node.getTextContent().slice(0, point.offset).slice(-1) : "";
}

function $textAfterPoint(point: PointType): string {
  if (point.type !== "text") return "";
  const node = point.getNode();
  return $isTextNode(node) ? node.getTextContent().slice(point.offset, point.offset + 1) : "";
}

/**
 * True when the block holding the point has no text: an empty editor or an empty paragraph. The caret there is an
 * element point, so the text-based neighbour checks see "" and cannot tell an empty line from the end of a word.
 */
function $isBlankBlockAt(point: PointType): boolean {
  const block = point.getNode().getTopLevelElement();
  if (!block) return true;
  return block
    .getChildren()
    .every((child) => $isTextNode(child) && child.getTextContent().length === 0);
}

/**
 * Inserts the body at the selection. Paragraph boundaries become real paragraph breaks.
 * Inline content keeps its mention chips; a single-paragraph body merges into the current line.
 * Spaces separate the body from adjacent words, as the plain-text insert path does, so the body never glues to a word.
 * An empty line gets no separator at all, so inserting into an empty editor yields exactly the stored markdown.
 */
export function $insertSerializedPromptBody(
  selection: RangeSelection,
  paragraphs: readonly SerializedLexicalNode[],
): void {
  if (paragraphs.length === 0) return;
  const [start, end] = selection.isBackward()
    ? [selection.focus, selection.anchor]
    : [selection.anchor, selection.focus];
  const before = $textBeforePoint(start);
  const after = $textAfterPoint(end);
  // Read before inserting: the insertion changes the block.
  const blankLine = $isBlankBlockAt(start);
  if (before && !/\s/.test(before)) selection.insertNodes([$createTextNode(" ")]);
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) selection.insertParagraph();
    const nodes: LexicalNode[] = paragraphChildren(paragraph).map((child) =>
      $parseSerializedNode(child),
    );
    if (nodes.length > 0) selection.insertNodes(nodes);
  });
  // A word directly after the caret needs a separator. At the end of a line, words before the caret need one so
  // typing can continue; an empty line needs none.
  const needsTrailing = after ? !/\s/.test(after) : !blankLine;
  if (needsTrailing) {
    const trailing = $createTextNode(" ");
    selection.insertNodes([trailing]);
    trailing.selectEnd();
  }
}

/**
 * Slash apply (spec rule 6): the typed `/query` range is removed first, then the body goes in. An empty body
 * therefore leaves nothing behind instead of the token.
 */
export function $replaceSelectionWithSerializedPromptBody(
  selection: RangeSelection,
  paragraphs: readonly SerializedLexicalNode[],
): void {
  selection.removeText();
  $insertSerializedPromptBody(selection, paragraphs);
}

/** Caret used by the editor: the live selection, or the document end when the editor has none. */
export function $selectionForSerializedInsert(): RangeSelection {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) return selection;
  return $getRoot().selectEnd();
}

/**
 * Replaces the whole document with the body. Callers load into an empty or dialog-owned editor only.
 * Every node is built before the root is touched: an unknown node type throws while the current document is still
 * intact, so a failed load never leaves an empty editor that a later save could write back.
 */
export function $loadSerializedPromptBody(paragraphs: readonly SerializedLexicalNode[]): void {
  const built = paragraphs.map((paragraph) => {
    const node = $createParagraphNode();
    node.append(...paragraphChildren(paragraph).map((child) => $parseSerializedNode(child)));
    return node;
  });
  const root = $getRoot();
  root.clear();
  root.append(...(built.length > 0 ? built : [$createParagraphNode()]));
  root.selectEnd();
}
