// @vitest-environment jsdom

import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { describe, expect, it, vi } from "vitest";

const serialize = vi.hoisted(() => vi.fn());

vi.mock("@/mentions/promptSerialization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mentions/promptSerialization.js")>();
  return {
    ...actual,
    $getPromptMarkdown: () => {
      serialize();
      return actual.$getPromptMarkdown();
    },
  };
});

const { createCachedEditorMarkdownReader } = await import("@/LexicalChatInput.js");

describe("createCachedEditorMarkdownReader", () => {
  it("serializes each editor state once so the previous state is not re-read on every keystroke", async () => {
    const editor = createEditor({ nodes: [] });
    const previousState = editor.getEditorState();
    await new Promise<void>((resolve) => {
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode("hello"));
          $getRoot().append(paragraph);
        },
        { discrete: true, onUpdate: resolve },
      );
    });
    const nextState = editor.getEditorState();
    const readMarkdown = createCachedEditorMarkdownReader();

    expect(readMarkdown(previousState)).toBe("");
    expect(readMarkdown(nextState)).toBe("hello");
    expect(readMarkdown(nextState)).toBe("hello");
    expect(readMarkdown(previousState)).toBe("");

    expect(serialize).toHaveBeenCalledTimes(2);
  });
});
