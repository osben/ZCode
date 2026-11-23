// Regression (desktop E2E DM, conversation-session-draft-model-switch-first-send): after an
// accepted send, the 350ms session-scope draft autosave must resume. The upstream 3.17.1 merge
// dropped the terminal finalize of settleSubmittedContent, so activeSubmissionDraftTransactionRef
// stayed armed for the sending incarnation (root→session promotion keeps the token) and
// persistDraftNow early-returned forever — nothing reached the session scope of
// zcode-v4-composer-drafts:v1 until a scope switch unmounted the composer.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { TEST_LOCALE } from "./helpers/uiCopy.js";
import { clearV4ComposerDraftWorkspaceTransferRequest } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import {
  ComposerWithDraftOwner,
  installMinimalDom,
  ROOT_DRAFT_SCOPE,
} from "./v4ConversationComposerLateAckHarness.js";

const { editor } = vi.hoisted(() => ({
  editor: {
    text: "",
    attached: true,
    onChange: null as ((value: string) => void) | null,
    onSubmit: null as ((value: string) => boolean) | null,
    apiRef: null as { current: unknown } | null,
  },
}));

// The draft owner (useDraftConfigControl) reads the session service and settings hooks; this suite
// has no ServiceProvider, so both are stubbed. The owner's write paths are exercised unchanged.
// Upstream 4.0.0 ComposerStatusRow measures its capsules with DOM APIs the minimal DOM lacks; this
// suite does not cover the status row.
vi.mock("@/v4/ConversationStatusPanel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/v4/ConversationStatusPanel.js")>()),
  ComposerStatusRow: () => null,
}));
vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({}),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {} }),
}));
vi.mock("@/hooks/useZCodeAgentService.js", () => {
  const agentService = {
    onDynamicPluginStartupDegraded: () => () => ({ dispose: () => {} }),
  };
  return { useZCodeAgentService: () => agentService };
});
vi.mock("@/voice-input/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/voice-input/index.js")>()),
  useComposerVoiceInput: () => ({
    available: false,
    state: "idle",
    toggle: () => {},
    settle: () => undefined,
    subscribeLevel: () => () => {},
  }),
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
    ControlHintTooltip: ({ children }: { children?: ReactNode }) =>
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
    clearHistory: vi.fn(),
    focus: vi.fn(),
    getEditorState: () => null,
    getMarkdown: () => editor.text,
    setEditorStateJson: vi.fn(),
    setText: (value: string) => {
      editor.text = value;
    },
  };
}

const SESSION_ID = "sess-after-send";
const onSendText = vi.fn(async () => {});
let pendingFrames: FrameRequestCallback[] = [];
let root: Root;

function storedSessionDraft() {
  return readV4ComposerDraft("/workspace", undefined, SESSION_ID, ROOT_DRAFT_SCOPE);
}

function renderSessionComposer() {
  act(() => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(ComposerWithDraftOwner, {
          draftMode: false,
          onSelectModel: vi.fn(),
          onSelectThought: vi.fn(),
          onSendText,
          submissionReady: true,
          modelSelectionView: null,
          modelSelectionSettled: false,
          onStop: vi.fn(),
          onSwitchMode: vi.fn(),
          provider: undefined,
          sessionId: SESSION_ID,
          snapshot: null,
          workspacePath: "/workspace",
        }),
      ),
    );
  });
}

function runFrames() {
  act(() => {
    const frames = pendingFrames;
    pendingFrames = [];
    for (const frame of frames) frame(0);
  });
}

function typeText(text: string) {
  act(() => {
    editor.text = text;
    editor.onChange?.(editor.text);
  });
}

beforeEach(() => {
  // The autosave commits after a 350ms silence window; the window timer is driven explicitly.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const container = installMinimalDom();
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
  vi.useRealTimers();
  pendingFrames = [];
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

describe("session draft autosave after an accepted send", () => {
  it("resumes the 350ms autosave once the submission settles", async () => {
    renderSessionComposer();
    runFrames();

    typeText("accepted message");
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(storedSessionDraft()?.text).toBe("accepted message");

    await act(async () => {
      editor.onSubmit?.("accepted message");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    runFrames();
    expect(onSendText).toHaveBeenCalledTimes(1);

    // The accepted send consumed the draft; typing afterwards must reach the same session scope.
    typeText("retained follow-up");
    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(storedSessionDraft()?.text).toBe("retained follow-up");
  });
});
