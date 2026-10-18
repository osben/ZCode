// @vitest-environment jsdom

import { createElement, useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $createParagraphNode, $createTextNode, type LexicalEditor } from "lexical";
import { VoiceGhostPreview } from "@/prompt-editor/VoiceGhostPreview.js";

// jsdom has no layout engine: give every box a fixed geometry and place the caret at x=50.
const originalElementRect = Element.prototype.getBoundingClientRect;
const originalRangeRects = Range.prototype.getClientRects;
const originalRangeRect = Range.prototype.getBoundingClientRect;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      left: 0,
      top: 0,
      width: 400,
      height: 120,
      right: 400,
      bottom: 120,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
  };
  const caretRect = {
    left: 50,
    top: 0,
    width: 0,
    height: 20,
    right: 50,
    bottom: 20,
    x: 50,
    y: 0,
    toJSON() {},
  };
  Range.prototype.getClientRects = function () {
    return [caretRect] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function () {
    return caretRect as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalElementRect;
  Range.prototype.getClientRects = originalRangeRects;
  Range.prototype.getBoundingClientRect = originalRangeRect;
  vi.restoreAllMocks();
});

function EditorHandle({ onEditor }: { onEditor: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onEditor(editor);
  }, [editor, onEditor]);
  return null;
}

function renderGhost(preview: { committed: string; tentative: string } | null) {
  let editor: LexicalEditor | null = null;
  const initialConfig = {
    namespace: "VoiceGhostTest",
    onError: (error: Error) => {
      throw error;
    },
    editorState: () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("Hello world"));
      $getRoot().clear().append(paragraph);
      $getRoot().selectEnd();
    },
  };
  render(
    createElement(
      LexicalComposer,
      { initialConfig },
      createElement("div", { className: "relative" }, [
        createElement(PlainTextPlugin, {
          key: "plain",
          contentEditable: createElement(ContentEditable, { "data-testid": "editor-root" }),
          ErrorBoundary: ({ children }: { children: unknown }) => children,
          placeholder: null,
        }),
        createElement(VoiceGhostPreview, { key: "ghost", preview }),
      ]),
      createElement(EditorHandle, { key: "handle", onEditor: (instance) => (editor = instance) }),
    ),
  );
  return () => editor!;
}

describe("VoiceGhostPreview (VD-GHO-01, VD-GHO-02)", () => {
  it("draws committed and tentative text as an aria-hidden overlay that is not part of the document", async () => {
    const getEditor = renderGhost({ committed: "Hel", tentative: "lo" });
    await waitFor(() => expect(screen.getByTestId("voice-dictation-ghost")).toBeTruthy());

    const ghost = screen.getByTestId("voice-dictation-ghost");
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.className).toContain("pointer-events-none");
    expect(ghost.textContent).toContain("Hel");
    expect(ghost.textContent).toContain("lo");
    // Committed and tentative text use different styles (VD-GHO-01).
    const tentative = ghost.querySelector("span");
    expect(tentative?.textContent).toBe("lo");
    expect(tentative?.className).toContain("italic");

    // The editor document keeps only the real draft (VD-GHO-02).
    const documentText = getEditor()
      .getEditorState()
      .read(() => $getRoot().getTextContent());
    expect(documentText).toBe("Hello world");
  });

  it("renders nothing when there is no preview text", async () => {
    renderGhost({ committed: "", tentative: "" });
    await act(async () => undefined);
    expect(screen.queryByTestId("voice-dictation-ghost")).toBeNull();
  });
});
