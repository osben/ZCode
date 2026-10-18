// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { insertEditorPlainTextAtSelection } from "@/LexicalChatInput.js";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
  PromptMentionNode,
} from "@/mentions/nodes/PromptMentionNode.js";

type Paragraphs = readonly string[];

async function createEditorWith(paragraphs: Paragraphs): Promise<LexicalEditor> {
  const editor = createEditor({ nodes: [] });
  editor.setRootElement(document.createElement("div"));
  await new Promise<void>((resolve) => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        for (const text of paragraphs) {
          const paragraph = $createParagraphNode();
          if (text) paragraph.append($createTextNode(text));
          root.append(paragraph);
        }
      },
      { onUpdate: resolve },
    );
  });
  return editor;
}

function select(
  editor: LexicalEditor,
  paragraphIndex: number,
  anchorOffset: number,
  focusOffset = anchorOffset,
) {
  return new Promise<void>((resolve) => {
    editor.update(
      () => {
        const paragraph = $getRoot().getChildren()[paragraphIndex]!;
        const textNode = paragraph.getFirstChild();
        if (textNode && "select" in textNode) {
          (textNode as { select(a: number, b: number): unknown }).select(anchorOffset, focusOffset);
        } else {
          (paragraph as { select(): unknown }).select();
        }
      },
      { onUpdate: resolve },
    );
  });
}

function clearSelection(editor: LexicalEditor) {
  return new Promise<void>((resolve) => {
    editor.update(() => $setSelection(null), { onUpdate: resolve });
  });
}

async function insert(editor: LexicalEditor, text: string) {
  await new Promise<void>((resolve) => {
    const unregister = editor.registerUpdateListener(() => {
      unregister();
      resolve();
    });
    insertEditorPlainTextAtSelection(editor, text);
  });
}

const paragraphsOf = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((node) => node.getTextContent()),
  );

describe("insertEditorPlainTextAtSelection", () => {
  it("inserts at the caret with a space only where the neighbours are not whitespace", async () => {
    const editor = await createEditorWith(["Hello world"]);
    await select(editor, 0, 5);
    await insert(editor, "there");
    expect(paragraphsOf(editor)).toEqual(["Hello there world"]);

    const second = await createEditorWith(["Hello world"]);
    await select(second, 0, 6);
    await insert(second, "there");
    expect(paragraphsOf(second)).toEqual(["Hello there world"]);
  });

  it("replaces the selected text", async () => {
    const editor = await createEditorWith(["Hello world"]);
    await select(editor, 0, 6, 11);
    await insert(editor, "there");
    expect(paragraphsOf(editor)).toEqual(["Hello there"]);
  });

  it("adds no padding at the start of an empty or whitespace-bordered draft", async () => {
    const editor = await createEditorWith([""]);
    await select(editor, 0, 0);
    await insert(editor, "there");
    expect(paragraphsOf(editor)).toEqual(["there"]);

    const trailing = await createEditorWith(["Hello "]);
    await select(trailing, 0, 6);
    await insert(trailing, "there");
    expect(paragraphsOf(trailing)).toEqual(["Hello there"]);
  });

  it("leaves other paragraphs untouched", async () => {
    const editor = await createEditorWith(["first", "second line"]);
    await select(editor, 1, 6);
    await insert(editor, "new");
    expect(paragraphsOf(editor)).toEqual(["first", "second new line"]);
  });

  it("appends to the end when the editor has no selection", async () => {
    const editor = await createEditorWith(["Hello"]);
    await clearSelection(editor);
    await insert(editor, "there");
    expect(paragraphsOf(editor)).toEqual(["Hello there"]);
  });

  it("keeps mention nodes intact and pads next to them", async () => {
    const editor = createEditor({ nodes: [PromptMentionNode] });
    editor.setRootElement(document.createElement("div"));
    await new Promise<void>((resolve) => {
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          paragraph.append(
            $createPromptMentionNode({
              id: "plugin:pdf",
              category: "plugins",
              label: "pdf",
              value: "pdf@zcode",
              markdown: "[@pdf](plugin://pdf@zcode)",
              data: { pluginId: "pdf@zcode" },
            }),
          );
          const tail = $createTextNode("tail");
          paragraph.append(tail);
          $getRoot().clear().append(paragraph);
          tail.select(0, 0);
        },
        { onUpdate: resolve },
      );
    });

    await insert(editor, "dictated");

    const result = editor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChild()!;
      return {
        mentions: paragraph.getChildren().filter((node) => $isPromptMentionNode(node)).length,
        text: paragraph.getChildren().map((node) => node.getTextContent()),
      };
    });
    expect(result.mentions).toBe(1);
    expect(result.text.join("")).toContain("dictated");
    expect(result.text.join("")).toMatch(/dictated\s*tail$/);
  });
});
