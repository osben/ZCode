// ISSUE-060 (docs/ui/composer-text-draft-persistence.md, DL01–DL03): the same composer instance is
// reused when a pane moves from a session to the new-task draft. Until the new scope's draft is in
// the editor, the editor text still belongs to the previous scope and must not be written anywhere.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { TEST_LOCALE } from "./helpers/uiCopy.js";
import {
  clearV4ComposerDraftWorkspaceTransferRequest,
  requestV4ComposerDraftWorkspaceTransfer,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { flushAsyncWork, installMinimalDom } from "./v4ConversationComposerLateAckHarness.js";

const { editor } = vi.hoisted(() => ({
  editor: {
    text: "",
    // While false the mocked prompt editor exposes no input API (editor not mounted yet).
    attached: true,
    onChange: null as ((value: string) => void) | null,
    onSubmit: null as ((value: string) => boolean) | null,
    apiRef: null as { current: unknown } | null,
  },
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

vi.mock("@/components/ui/dialog.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    DialogClose: Passthrough,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) => {
      editor.onChange = props.onChange as (value: string) => void;
      editor.onSubmit = props.onSubmit as (value: string) => boolean;
      const inputApiRef = props.inputApiRef as { current: unknown } | undefined;
      if (inputApiRef) {
        editor.apiRef = inputApiRef;
        inputApiRef.current = editor.attached ? createInputApi() : null;
      }
      return React.createElement("form", { "data-testid": "mock-chat-prompt-editor" });
    },
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachmentError: null,
    adoptSentAttachments: vi.fn(async () => {}),
    attachmentInputRef: { current: null },
    attachments: [],
    clearAttachments: vi.fn(),
    handleAttachmentInputChange: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handlePaste: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    hasAttachments: false,
    hasUnreadyAttachments: false,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: vi.fn(async () => []),
    removeAttachment: vi.fn(),
    restoreDraftAttachments: vi.fn(),
    restoreSessionOwnedAttachments: vi.fn(),
    retryAttachment: vi.fn(),
    setAttachmentError: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  return {
    V4ComposerModeSwitch: () => React.createElement("span", null, "mode"),
    V4ComposerModelControls: () => React.createElement("span", null, "model"),
  };
});

function createInputApi() {
  return {
    clear: () => {
      editor.text = "";
    },
    focus: vi.fn(),
    getEditorState: () => null,
    getMarkdown: () => editor.text,
    setEditorStateJson: vi.fn(),
    setText: (value: string) => {
      editor.text = value;
    },
  };
}

const SESSION_A = "qa-session-a";
const onSendText = vi.fn(async () => {});
let pendingFrames: FrameRequestCallback[] = [];
let root: Root;

function scopeOf(sessionId: string | null) {
  return sessionId ?? V4_DRAFT_SCOPE_ROOT;
}

function storedText(sessionId: string | null, workspacePath = "/workspace") {
  return readV4ComposerDraft(workspacePath, undefined, scopeOf(sessionId))?.text ?? null;
}

// Emulates the SessionPane draft owner: each render gets the owner of the scope it shows.
function composerFor(sessionId: string | null, workspacePath: string) {
  const scopeId = scopeOf(sessionId);
  let ownedDraft: V4ComposerDraft = readV4ComposerDraft(workspacePath, undefined, scopeId) ?? {
    text: "",
    updatedAt: 0,
  };
  const write = (next: V4ComposerDraft) => {
    ownedDraft = next;
    persistV4ComposerDraft(workspacePath, undefined, scopeId, ownedDraft);
  };
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: TEST_LOCALE },
    createElement(ConversationComposer, {
      draftMode: sessionId === null,
      onSelectModel: vi.fn(),
      onSelectThought: vi.fn(),
      onSendText,
      submissionReady: true,
      modelSelectionView: null,
      modelSelectionSettled: false,
      composerDraft: ownedDraft,
      updateComposerContent: (content) => write({ ...ownedDraft, ...content }),
      replaceComposerDraft: (next) => write({ ...next, updatedAt: Date.now() }),
      onStop: vi.fn(),
      onSwitchMode: vi.fn(),
      provider: undefined,
      sessionId,
      snapshot: null,
      workspacePath,
    }),
  );
}

function render(sessionId: string | null, workspacePath = "/workspace") {
  act(() => root.render(composerFor(sessionId, workspacePath)));
}

function runFrames() {
  act(() => {
    const frames = pendingFrames;
    pendingFrames = [];
    for (const frame of frames) frame(0);
  });
}

function openSessionAWithDraft() {
  persistV4ComposerDraft("/workspace", undefined, SESSION_A, {
    text: "qa draft A",
    mode: "build",
    updatedAt: 1,
  });
  render(SESSION_A);
  runFrames();
  expect(editor.text).toBe("qa draft A");
}

beforeEach(() => {
  const container = installMinimalDom();
  // A hidden or occluded Electron window pauses animation frames; frames run only on demand here.
  const frameApi = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    },
    cancelAnimationFrame: (id: number) => {
      pendingFrames[id - 1] = () => {};
    },
  };
  Object.assign(window, frameApi);
  for (const [name, value] of Object.entries(frameApi)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  editor.text = "";
  editor.attached = true;
  editor.onChange = null;
  editor.onSubmit = null;
  editor.apiRef = null;
  onSendText.mockClear();
  clearV4ComposerDraftWorkspaceTransferRequest();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  pendingFrames = [];
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

describe("ConversationComposer draft scope switch (ISSUE-060)", () => {
  it("DL01: a window blur right after leaving a session does not copy its text into the new-task draft", () => {
    openSessionAWithDraft();

    render(null);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(storedText(null)).toBeNull();
    expect(editor.text).toBe("");
    expect(storedText(SESSION_A)).toBe("qa draft A");
  });

  it("DL02: typing right after leaving a session stores only the typed text in the new-task draft", () => {
    openSessionAWithDraft();

    render(null);
    act(() => {
      editor.text = `${editor.text}qa draft new`;
      editor.onChange?.(editor.text);
    });
    runFrames();

    expect(storedText(null)).toBe("qa draft new");
    expect(storedText(SESSION_A)).toBe("qa draft A");
  });

  it("DL03: while the editor is not ready, nothing is written and the new scope's draft is shown once it is", () => {
    openSessionAWithDraft();
    persistV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "qa draft new",
      mode: "build",
      updatedAt: 2,
    });

    editor.attached = false;
    render(null);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(storedText(null)).toBe("qa draft new");

    editor.attached = true;
    render(null);
    runFrames();

    expect(editor.text).toBe("qa draft new");
    expect(storedText(null)).toBe("qa draft new");
    expect(storedText(SESSION_A)).toBe("qa draft A");
  });

  it("DL03b: a deferred restore waits frame by frame for the editor, then writes resume", () => {
    openSessionAWithDraft();
    persistV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "qa draft new",
      mode: "build",
      updatedAt: 2,
    });

    editor.attached = false;
    render(null);
    runFrames();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(storedText(null)).toBe("qa draft new");

    // The editor attaches without a composer re-render; only the next frame may restore.
    editor.apiRef!.current = createInputApi();
    runFrames();
    expect(editor.text).toBe("qa draft new");

    act(() => {
      editor.text = "qa draft new!";
      editor.onChange?.(editor.text);
    });
    expect(storedText(null)).toBe("qa draft new!");
    expect(storedText(SESSION_A)).toBe("qa draft A");
  });

  it("DL04: a submit before the new scope's draft lands does not send the previous session's text", async () => {
    openSessionAWithDraft();

    editor.attached = false;
    render(null);
    await act(async () => {
      editor.onSubmit?.("qa draft A");
      await flushAsyncWork();
    });

    expect(onSendText).not.toHaveBeenCalled();
    expect(storedText(SESSION_A)).toBe("qa draft A");
  });

  it("DL05: a workspace transfer during a pending restore carries the draft's own text, not the editor's", () => {
    openSessionAWithDraft();
    persistV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "qa draft new",
      mode: "build",
      updatedAt: 2,
    });

    editor.attached = false;
    render(null);
    requestV4ComposerDraftWorkspaceTransfer({
      sourceWorkspacePath: "/workspace",
      targetWorkspacePath: "/other",
    });
    render(null, "/other");

    expect(storedText(null, "/other")).toBe("qa draft new");

    editor.attached = true;
    render(null, "/other");
    runFrames();
    expect(editor.text).toBe("qa draft new");
    expect(storedText(SESSION_A)).toBe("qa draft A");
  });
});
