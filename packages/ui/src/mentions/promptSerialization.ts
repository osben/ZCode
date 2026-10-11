import {
  $getCharacterOffsets,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
  type RangeSelection,
} from "lexical";
import { $isPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";

/** Editor text is used for cursor positioning; business output reads canonical explicitly and must not override TextNode text semantics. */
export function $getPromptMarkdown(node: LexicalNode = $getRoot()): string {
  if ($isPromptMentionNode(node)) return node.getMarkdown();
  if (!$isElementNode(node)) return node.getTextContent();
  const children = node.getChildren();
  return children
    .map(
      (child, index) =>
        $getPromptMarkdown(child) +
        ($isElementNode(child) && !child.isInline() && index < children.length - 1 ? "\n\n" : ""),
    )
    .join("");
}

/** Follow Lexical RangeSelection paragraph/endpoint rules and replace only tokens that are actually selected with their canonical form. */
export function $getPromptSelectionMarkdown(selection: RangeSelection): string {
  if (selection.isCollapsed()) return "";
  const nodes = selection.getNodes();
  const [anchorOffset, focusOffset] = $getCharacterOffsets(selection);
  const forward = selection.anchor.isBefore(selection.focus);
  const start = forward ? anchorOffset : focusOffset;
  const end = forward ? focusOffset : anchorOffset;
  let result = "";
  let previousWasElement = true;
  for (const [index, node] of nodes.entries()) {
    if ($isElementNode(node) && !node.isInline()) {
      if (!previousWasElement) result += "\n";
      previousWasElement = !node.isEmpty();
      continue;
    }
    previousWasElement = false;
    let text = node.getTextContent();
    if ($isTextNode(node)) {
      let from = index === 0 ? start : 0;
      let to = index === nodes.length - 1 ? end : text.length;
      // When two element points enclose the same text node, offset is a child index rather than a character index.
      if (
        nodes.length === 1 &&
        selection.anchor.type === "element" &&
        selection.focus.type === "element" &&
        selection.anchor.offset !== selection.focus.offset
      ) {
        from = 0;
        to = text.length;
      }
      text = text.slice(from, to);
      if (text && $isPromptMentionNode(node)) text = node.getMarkdown();
    }
    result += text;
  }
  return result;
}

/** Cut and copy treat any intersecting token as a whole, but must not expand a selection that only touches its boundary. */
export function $getAtomicPromptSelection(selection: RangeSelection): RangeSelection {
  const normalized = selection.clone();
  if (normalized.isCollapsed()) return normalized;
  const [start, end] = normalized.isBackward()
    ? [normalized.focus, normalized.anchor]
    : [normalized.anchor, normalized.focus];
  const startNode = start.getNode();
  const endNode = end.getNode();
  if (
    start.type === "text" &&
    $isPromptMentionNode(startNode) &&
    start.offset < startNode.getTextContentSize()
  ) {
    start.set(start.key, 0, "text");
  }
  if (end.type === "text" && $isPromptMentionNode(endNode) && end.offset > 0) {
    end.set(end.key, endNode.getTextContentSize(), "text");
  }
  return normalized;
}
