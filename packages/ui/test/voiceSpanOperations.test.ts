// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import {
  VoiceTentativeTextNode,
  VoiceTextNode,
  $isVoiceTextNode,
} from "../src/prompt-editor/voice-span/VoiceTextNode.js";
import {
  $cancelVoiceSpan,
  $finalizeVoiceSpan,
  $updateVoiceSpan,
  type VoiceSpanState,
} from "../src/prompt-editor/voice-span/voiceSpanOperations.js";

function makeTestEditor(): LexicalEditor {
  return createEditor({
    namespace: "voice-span-test",
    nodes: [VoiceTextNode, VoiceTentativeTextNode],
    onError: (error) => {
      throw error;
    },
  });
}

function makeState(): VoiceSpanState {
  return { committedKey: null, tentativeKey: null };
}

/** Runs one span operation and returns the resulting root text. */
function apply(editor: LexicalEditor, state: VoiceSpanState, run: () => void): string {
  editor.update(
    () => {
      run();
    },
    { discrete: true },
  );
  let text = "";
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

describe("voice span operations (specs/voice-dictation.md)", () => {
  it("creates the span, replaces its content in place, and keeps its node identity", () => {
    const editor = makeTestEditor();
    const state = makeState();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("before "), $createTextNode("after"));
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );

    // A headless editor has no selection, so the span lands at the paragraph end — the same
    // fallback a real editor uses when the caret was lost.
    expect(
      apply(editor, state, () => $updateVoiceSpan({ committed: "hello", tentative: "the" }, state)),
    ).toBe("before afterhellothe");

    editor.getEditorState().read(() => {
      const nodes = $getRoot().getAllTextNodes();
      expect(nodes.filter((node) => $isVoiceTextNode(node))).toHaveLength(1);
      expect(nodes.filter((node) => node instanceof VoiceTentativeTextNode)).toHaveLength(1);
    });

    // Later previews replace in place: text around the span is untouched.
    expect(
      apply(editor, state, () =>
        $updateVoiceSpan({ committed: "hello there", tentative: "" }, state),
      ),
    ).toBe("before afterhello there");

    // In-place identity: the committed node keeps its key across updates.
    let committedKey = "";
    editor.getEditorState().read(() => {
      committedKey =
        $getRoot()
          .getAllTextNodes()
          .find((node) => $isVoiceTextNode(node))
          ?.getKey() ?? "";
    });
    apply(editor, state, () =>
      $updateVoiceSpan({ committed: "hello there!", tentative: "" }, state),
    );
    editor.getEditorState().read(() => {
      const committed = $getRoot()
        .getAllTextNodes()
        .find((node) => $isVoiceTextNode(node));
      expect(committed?.getKey()).toBe(committedKey);
    });
  });

  it("finalize replaces the span with plain text and drops an empty final entirely", () => {
    const editor = makeTestEditor();
    const state = makeState();
    apply(editor, state, () => $updateVoiceSpan({ committed: "hello", tentative: "!" }, state));

    expect(apply(editor, state, () => $finalizeVoiceSpan("hello!", state))).toBe("hello!");
    editor.getEditorState().read(() => {
      expect(
        $getRoot()
          .getAllTextNodes()
          .some((node) => $isVoiceTextNode(node)),
      ).toBe(false);
    });

    apply(editor, state, () => $updateVoiceSpan({ committed: "again", tentative: "" }, state));
    // The span sits after the first finalize's leftover text; an empty final removes only the span.
    expect(apply(editor, state, () => $finalizeVoiceSpan("", state))).toBe("hello!");
  });

  it("finalize without a live span inserts the text (one-shot parity)", () => {
    const editor = makeTestEditor();
    const state = makeState();
    expect(apply(editor, state, () => $finalizeVoiceSpan("one-shot text", state))).toContain(
      "one-shot text",
    );
  });

  it("cancel removes the span without inserting anything", () => {
    const editor = makeTestEditor();
    const state = makeState();
    apply(editor, state, () =>
      $updateVoiceSpan({ committed: "keep this draft", tentative: "x" }, state),
    );
    expect(apply(editor, state, () => $cancelVoiceSpan(state))).toBe("");
    expect(state.committedKey).toBeNull();
    expect(state.tentativeKey).toBeNull();
  });

  it("stale keys from a removed span do not break the next update", () => {
    const editor = makeTestEditor();
    const state: VoiceSpanState = { committedKey: "stale", tentativeKey: null };
    expect(
      apply(editor, state, () => $updateVoiceSpan({ committed: "fresh", tentative: "" }, state)),
    ).toContain("fresh");
  });
});
