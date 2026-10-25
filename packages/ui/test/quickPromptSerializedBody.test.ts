// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { $createPromptMentionNode, PromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import {
  $insertSerializedPromptBody,
  $loadSerializedPromptBody,
  $readSerializedPromptBody,
  $replaceSelectionWithSerializedPromptBody,
  $selectionForSerializedInsert,
  parseSerializedPromptBodyNodes,
} from "@/prompt-body/index.js";

const fileMention = {
  id: "file:demo",
  category: "files" as const,
  label: "@demo.ts",
  value: "src/demo.ts",
  markdown: "[demo.ts](src/demo.ts)",
  data: { path: "src/demo.ts" },
};

function newEditor(): LexicalEditor {
  return createEditor({
    nodes: [PromptMentionNode],
    onError: (error) => {
      throw error;
    },
  });
}

function fill(editor: LexicalEditor, run: () => void) {
  editor.update(run, { discrete: true });
}

describe("serialized prompt body (quick prompt body round trip)", () => {
  it("keeps mention chips through save and load, and the markdown is canonical", () => {
    const source = newEditor();
    fill(source, () => {
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createTextNode("review "),
        $createPromptMentionNode(fileMention),
        $createTextNode(" now"),
      );
      $getRoot().append(paragraph);
    });
    const saved = source.getEditorState().read(() => $readSerializedPromptBody());
    expect(saved.markdown).toBe("review [demo.ts](src/demo.ts) now");
    expect(saved.nodes).toContain("prompt-mention");

    const target = newEditor();
    fill(target, () => $loadSerializedPromptBody(parseSerializedPromptBodyNodes(saved.nodes)));
    const loaded = target.getEditorState().read(() => $readSerializedPromptBody());
    expect(loaded.markdown).toBe(saved.markdown);
    expect(loaded.nodes).toBe(saved.nodes);
  });

  it("inserts at the caret without moving the surrounding text (scenario 2)", () => {
    const editor = newEditor();
    fill(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("hello world"));
      $getRoot().append(paragraph);
    });
    const body = newEditor();
    fill(body, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createPromptMentionNode(fileMention), $createTextNode(" tests"));
      $getRoot().append(paragraph);
    });
    const nodes = body.getEditorState().read(() => $readSerializedPromptBody().nodes);

    fill(editor, () => {
      const text = $getRoot().getFirstDescendant();
      if (!text) throw new Error("expected text");
      text.select(5, 5);
      const selection = $selectionForSerializedInsert();
      $insertSerializedPromptBody(selection, parseSerializedPromptBodyNodes(nodes));
    });
    const result = editor.getEditorState().read(() => $readSerializedPromptBody().markdown);
    // The caret sits before the existing space, so the body gets one leading space and no trailing one.
    expect(result).toBe("hello [demo.ts](src/demo.ts) tests world");
  });

  it("appends at the document end when the editor has no selection", () => {
    const editor = newEditor();
    fill(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("first"));
      $getRoot().append(paragraph);
    });
    const nodes = JSON.stringify([
      {
        type: "paragraph",
        children: [
          {
            type: "text",
            text: "second",
            format: 0,
            style: "",
            mode: "normal",
            detail: 0,
            version: 1,
          },
        ],
      },
    ]);
    fill(editor, () => {
      const selection = $selectionForSerializedInsert();
      expect($isRangeSelection($getSelection())).toBe(true);
      $insertSerializedPromptBody(selection, parseSerializedPromptBodyNodes(nodes));
    });
    expect(editor.getEditorState().read(() => $readSerializedPromptBody().markdown)).toBe(
      "first second ",
    );
  });

  it("inserts into an empty editor without a trailing space, so the send path sends the stored markdown exactly", () => {
    const source = newEditor();
    fill(source, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("review "), $createPromptMentionNode(fileMention));
      $getRoot().append(paragraph);
    });
    const saved = source.getEditorState().read(() => $readSerializedPromptBody());

    const editor = newEditor();
    fill(editor, () => $getRoot().append($createParagraphNode()));
    fill(editor, () => {
      $insertSerializedPromptBody(
        $selectionForSerializedInsert(),
        parseSerializedPromptBodyNodes(saved.nodes),
      );
    });
    expect(editor.getEditorState().read(() => $readSerializedPromptBody().markdown)).toBe(
      saved.markdown,
    );
  });

  it("still separates a mid-word insert from both neighbours", () => {
    const editor = newEditor();
    fill(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("helloworld"));
      $getRoot().append(paragraph);
    });
    const nodes = JSON.stringify([
      {
        type: "paragraph",
        version: 1,
        children: [
          {
            type: "text",
            text: "review the diff",
            format: 0,
            style: "",
            mode: "normal",
            detail: 0,
            version: 1,
          },
        ],
      },
    ]);
    fill(editor, () => {
      const text = $getRoot().getFirstDescendant();
      if (!text) throw new Error("expected text");
      text.select(5, 5);
      $insertSerializedPromptBody(
        $selectionForSerializedInsert(),
        parseSerializedPromptBodyNodes(nodes),
      );
    });
    expect(editor.getEditorState().read(() => $readSerializedPromptBody().markdown)).toBe(
      "hello review the diff world",
    );
  });

  it("removes the typed slash token even when the stored body has no paragraphs", () => {
    const editor = newEditor();
    fill(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("hello /re"));
      $getRoot().append(paragraph);
    });
    fill(editor, () => {
      const text = $getRoot().getFirstDescendant();
      if (!text) throw new Error("expected text");
      text.select(6, 9);
      $replaceSelectionWithSerializedPromptBody($selectionForSerializedInsert(), []);
    });
    expect(editor.getEditorState().read(() => $readSerializedPromptBody().markdown)).toBe("hello ");
  });

  it("replaces the slash token with the body when the body has paragraphs", () => {
    const editor = newEditor();
    fill(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("hello /re"));
      $getRoot().append(paragraph);
    });
    const nodes = JSON.stringify([
      {
        type: "paragraph",
        version: 1,
        children: [
          {
            type: "text",
            text: "review",
            format: 0,
            style: "",
            mode: "normal",
            detail: 0,
            version: 1,
          },
        ],
      },
    ]);
    fill(editor, () => {
      const text = $getRoot().getFirstDescendant();
      if (!text) throw new Error("expected text");
      text.select(6, 9);
      $replaceSelectionWithSerializedPromptBody(
        $selectionForSerializedInsert(),
        parseSerializedPromptBodyNodes(nodes),
      );
    });
    expect(editor.getEditorState().read(() => $readSerializedPromptBody().markdown)).toBe(
      "hello review ",
    );
  });

  it("keeps the current document when a stored body cannot be rebuilt", () => {
    const editor = newEditor();
    fill(editor, () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("keep me"));
      $getRoot().append(paragraph);
    });
    const broken = parseSerializedPromptBodyNodes(
      JSON.stringify([
        { type: "paragraph", version: 1, children: [{ type: "unknown-kind", version: 1 }] },
      ]),
    );
    const outcome: { error?: unknown } = {};
    fill(editor, () => {
      try {
        $loadSerializedPromptBody(broken);
      } catch (cause) {
        outcome.error = cause;
      }
    });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(editor.getEditorState().read(() => $readSerializedPromptBody().markdown)).toBe(
      "keep me",
    );
  });

  it("rejects a malformed stored body instead of inserting part of it", () => {
    expect(() => parseSerializedPromptBodyNodes("{not json")).toThrow();
    expect(() => parseSerializedPromptBodyNodes('{"type":"paragraph"}')).toThrow(/JSON array/);
  });
});
