// @vitest-environment jsdom

import { createElement, useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  type LexicalEditor,
  type ParagraphNode,
} from "lexical";
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

function buildHelloWorld() {
  const paragraph = $createParagraphNode();
  paragraph.append($createTextNode("Hello world"));
  $getRoot().clear().append(paragraph);
  $getRoot().selectEnd();
}

function renderGhost(
  preview: { committed: string; tentative: string } | null,
  build: () => void = buildHelloWorld,
) {
  let editor: LexicalEditor | null = null;
  const initialConfig = {
    namespace: "VoiceGhostTest",
    onError: (error: Error) => {
      throw error;
    },
    editorState: build,
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

function rectAt(left: number, top: number, height: number): DOMRect {
  return {
    left,
    top,
    width: 0,
    height,
    right: left,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

/** Builds a draft without a stored selection, so the ghost measures the append point (the no-selection path). */
function buildDraft(append: (paragraph: ParagraphNode) => void) {
  return () => {
    const paragraph = $createParagraphNode();
    append(paragraph);
    $getRoot().clear().append(paragraph);
  };
}

describe("VoiceGhostPreview insertion point without a stored selection", () => {
  const preview = { committed: "Hel", tentative: "lo" };
  let rangeAnchors: Array<{ container: Node; offset: number; collapsed: boolean }> = [];
  let caret = rectAt(0, 0, 20);

  beforeEach(() => {
    rangeAnchors = [];
    caret = rectAt(0, 0, 20);
    Range.prototype.getClientRects = function () {
      rangeAnchors.push({
        container: this.startContainer,
        offset: this.startOffset,
        collapsed: this.collapsed,
      });
      return [caret] as unknown as DOMRectList;
    };
    Range.prototype.getBoundingClientRect = function () {
      return caret;
    };
  });

  function ghostLayer(): HTMLElement {
    return screen.getByTestId("voice-dictation-ghost").firstElementChild as HTMLElement;
  }

  /** The append point must be a collapsed range right after the paragraph's last child. */
  function expectAppendPointAfterLastChild() {
    const paragraph = document.querySelector('[data-testid="editor-root"]')!.lastElementChild!;
    const anchor = rangeAnchors.at(-1);
    expect(anchor?.collapsed).toBe(true);
    expect(anchor?.container).toBe(paragraph);
    expect(anchor?.offset).toBe(paragraph.childNodes.length);
  }

  it("starts an empty composer's ghost at the paragraph's start edge, not its right edge", async () => {
    // The paragraph box spans 0..400, so the old right-edge measurement would indent 352px.
    renderGhost(
      preview,
      buildDraft(() => undefined),
    );
    await waitFor(() => expect(screen.getByTestId("voice-dictation-ghost")).toBeTruthy());
    expect(parseFloat(ghostLayer().style.textIndent)).toBe(0);
  });

  it("places a wrapped draft's ghost on its last visual line, not the paragraph's first line", async () => {
    caret = rectAt(30, 40, 20);
    renderGhost(
      preview,
      buildDraft((paragraph) =>
        paragraph.append($createTextNode("A long draft that wraps across several visual lines")),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("voice-dictation-ghost")).toBeTruthy());
    expectAppendPointAfterLastChild();
    expect(parseFloat(ghostLayer().style.textIndent)).toBe(30);
    // Caret line top 40, minus the 0.5px half-leading of a 20px glyph in a 21px line.
    expect(parseFloat(ghostLayer().style.top)).toBeCloseTo(39.5);
  });

  it("places a draft ending in a mention after the mention, not inside it", async () => {
    caret = rectAt(120, 0, 20);
    renderGhost(
      preview,
      buildDraft((paragraph) => {
        paragraph.append($createTextNode("Review "));
        paragraph.append($createTextNode("@src/app.ts").setMode("token"));
      }),
    );
    await waitFor(() => expect(screen.getByTestId("voice-dictation-ghost")).toBeTruthy());
    expectAppendPointAfterLastChild();
    expect(parseFloat(ghostLayer().style.textIndent)).toBe(120);
  });

  it("places a draft ending in a line break on the line after it", async () => {
    caret = rectAt(0, 60, 20);
    renderGhost(
      preview,
      buildDraft((paragraph) => {
        paragraph.append($createTextNode("First line"));
        paragraph.append($createLineBreakNode());
      }),
    );
    await waitFor(() => expect(screen.getByTestId("voice-dictation-ghost")).toBeTruthy());
    expectAppendPointAfterLastChild();
    expect(parseFloat(ghostLayer().style.textIndent)).toBe(0);
    expect(parseFloat(ghostLayer().style.top)).toBeCloseTo(59.5);
  });
});
