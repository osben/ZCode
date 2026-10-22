// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { KEY_ENTER_COMMAND, type LexicalEditor } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardPlugin } from "@/LexicalChatInput.js";

// Real Lexical editor, real KeyboardPlugin, real command dispatch. Only the settings snapshot
// (shortcut overrides) is supplied by the test.
const settings = vi.hoisted(() => ({
  shortcutBindings: undefined as Record<string, string[]> | undefined,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: { shortcutBindings: settings.shortcutBindings } }),
}));

interface Harness {
  root: Root;
  container: HTMLElement;
  editor: LexicalEditor;
}

let harness: Harness | null = null;

afterEach(() => {
  if (harness) {
    act(() => harness!.root.unmount());
    harness.container.remove();
    harness = null;
  }
  settings.shortcutBindings = undefined;
});

function EditorCapture({ onReady }: { onReady(editor: LexicalEditor): void }) {
  const [editor] = useLexicalComposerContext();
  onReady(editor);
  return null;
}

function mountKeyboard(props: {
  submitDisabled: boolean;
  enterSubmits?: boolean;
  onSubmit: (text: string) => unknown;
  onSubmitBlocked?: () => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let captured: LexicalEditor | null = null;
  act(() => {
    root.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: "keyboard-blocked-send-test",
            onError: (error: Error) => {
              throw error;
            },
            nodes: [],
          },
        },
        createElement(KeyboardPlugin, {
          onSubmit: props.onSubmit as never,
          onSubmitBlocked: props.onSubmitBlocked,
          submitDisabled: props.submitDisabled,
          allowSubmitWhenEmpty: true,
          enterSubmits: props.enterSubmits ?? true,
        }),
        createElement(EditorCapture, {
          onReady: (editor: LexicalEditor) => {
            captured = editor;
          },
        }),
      ),
    );
  });
  if (!captured) throw new Error("editor was not captured");
  harness = { root, container, editor: captured };
  return harness.editor;
}

// Dispatch a keydown the way Lexical does. Returns whether a listener handled it; a handled Enter
// means no newline is inserted, so an unhandled one falls through to Lexical's paragraph insertion.
function pressKey(editor: LexicalEditor, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  let handled = false;
  act(() => {
    handled = editor.dispatchCommand(KEY_ENTER_COMMAND, event);
  });
  return { handled, event };
}

describe("KeyboardPlugin Enter while submit is blocked by a named reason (ISSUE-026)", () => {
  it("default Enter binding: keeps the draft (no newline) and reports the reason", () => {
    const onSubmit = vi.fn();
    const onSubmitBlocked = vi.fn();
    const editor = mountKeyboard({ submitDisabled: true, onSubmit, onSubmitBlocked });

    const { handled, event } = pressKey(editor, { key: "Enter", code: "Enter" });

    expect(onSubmitBlocked).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("rebound Ctrl+Enter send: the rebound key is blocked the same way and plain Enter still inserts a newline", () => {
    settings.shortcutBindings = { composerSend: ["Ctrl+Enter"] };
    const onSubmit = vi.fn();
    const onSubmitBlocked = vi.fn();
    const editor = mountKeyboard({ submitDisabled: true, onSubmit, onSubmitBlocked });

    const plain = pressKey(editor, { key: "Enter", code: "Enter" });
    expect(plain.handled).toBe(false);
    expect(onSubmitBlocked).not.toHaveBeenCalled();

    const rebound = pressKey(editor, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(onSubmitBlocked).toHaveBeenCalledTimes(1);
    expect(rebound.handled).toBe(true);
    expect(rebound.event.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("without a named reason, a blocked Enter keeps the existing newline behavior", () => {
    const onSubmit = vi.fn();
    const editor = mountKeyboard({ submitDisabled: true, onSubmit });

    const { handled, event } = pressKey(editor, { key: "Enter", code: "Enter" });

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("with mobile enterSubmits off, Enter is not taken by the blocked-send path", () => {
    const onSubmitBlocked = vi.fn();
    const editor = mountKeyboard({
      submitDisabled: true,
      enterSubmits: false,
      onSubmit: vi.fn(),
      onSubmitBlocked,
    });

    const { handled } = pressKey(editor, { key: "Enter", code: "Enter" });

    expect(onSubmitBlocked).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it("an unblocked default Enter still submits", () => {
    const onSubmit = vi.fn(() => false);
    const onSubmitBlocked = vi.fn();
    const editor = mountKeyboard({ submitDisabled: false, onSubmit, onSubmitBlocked });

    const { handled } = pressKey(editor, { key: "Enter", code: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmitBlocked).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });
});
