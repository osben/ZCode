import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPromptHistoryStorageKey,
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TEST_LOCALE } from "./helpers/uiCopy.js";
import {
  ConversationComposer,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { getComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

const { attachmentState, chatPromptEditorProps, dialogOpenStates, inputClear, inputSetText } =
  vi.hoisted(() => ({
    attachmentState: {
      adoptSentAttachments: vi.fn(async () => {}),
      hasUnreadyAttachments: false,
      prepareForSend: vi.fn(async () => []),
    },
    chatPromptEditorProps: [] as Array<Record<string, unknown>>,
    dialogOpenStates: [] as boolean[],
    inputClear: vi.fn(),
    inputSetText: vi.fn(),
  }));

function expectedTelemetrySendOptions() {
  return expect.objectContaining({
    telemetrySeed: {
      sendTime: expect.any(Number),
      extraDetail: {
        ask_mode: "",
        model_name: "",
        model_provider: "glm",
        agent: "glm",
        plan_status: "unknown",
        plan_product_id: "",
        message_source: "chat",
        task_trigger: "",
      },
    },
  });
}

vi.mock("@/components/ui/dialog.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) => {
      dialogOpenStates.push(Boolean(open));
      return open ? React.createElement(React.Fragment, null, children) : null;
    },
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
      chatPromptEditorProps.push(props);
      const inputApiRef = props.inputApiRef as
        | { current: Record<string, unknown> | null }
        | undefined;
      if (inputApiRef) {
        inputApiRef.current = {
          clear: inputClear,
          focus: vi.fn(),
          getEditorState: () => null,
          getMarkdown: () => "",
          setEditorStateJson: vi.fn(),
          setText: inputSetText,
        };
      }
      return React.createElement(
        "form",
        { "data-testid": "mock-chat-prompt-editor" },
        props.topContent as ReactNode,
        props.leadingActions as ReactNode,
        props.submitControl as ReactNode,
      );
    },
  };
});

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
  } & Record<string, unknown>) => React.createElement("div", props, children);
  const Trigger = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Span = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Attachment: Passthrough,
    AttachmentHoverCard: Passthrough,
    AttachmentHoverCardContent: Passthrough,
    AttachmentHoverCardTrigger: Trigger,
    AttachmentInfo: Span,
    AttachmentPreview: Span,
    AttachmentRemove: (props: Record<string, unknown>) => React.createElement("button", props),
    Attachments: Passthrough,
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachmentError: null,
    adoptSentAttachments: attachmentState.adoptSentAttachments,
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
    hasUnreadyAttachments: attachmentState.hasUnreadyAttachments,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: attachmentState.prepareForSend,
    removeAttachment: vi.fn(),
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

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    attributes: new Map<string, string>(),
    childNodes: [] as Node[],
    getAttribute: (name: string) => element.attributes.get(name) ?? null,
    insertBefore: (child: Node, beforeChild?: Node | null) => {
      Object.assign(child, { parentNode: element });
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as Node | null,
    removeAttribute: (name: string) => {
      element.attributes.delete(name);
    },
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      Object.assign(child, { parentNode: null });
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => {
      element.attributes.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  } as Storage;
}

function installMinimalDom() {
  const target = new EventTarget();
  const documentMock = {
    addEventListener: () => {},
    createComment: (nodeValue: string) => ({
      nodeType: 8,
      nodeValue,
      parentNode: null,
    }),
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const body = createMinimalElement(documentMock as unknown as Document, "body");
  Object.assign(documentMock, { body });
  const windowMock = {
    addEventListener: target.addEventListener.bind(target),
    cancelAnimationFrame: () => {},
    clearTimeout,
    dispatchEvent: (event: Event) => target.dispatchEvent(event),
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    localStorage: createStorageMock(),
    matchMedia: () => ({
      addEventListener: () => {},
      addListener: () => {},
      matches: false,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
    Node: function Node() {},
    removeEventListener: target.removeEventListener.bind(target),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    setTimeout,
  };
  documentMock.defaultView = windowMock;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderComposerElement(
  onSendText: (text: string, options?: unknown) => Promise<ConversationComposerSendResult | void>,
  sessionId: string | null,
  telemetryDraftConfig?: {
    mode?: string;
    model?: string;
    provider?: string;
  },
  skillCatalogSessionId?: string | null,
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null,
  composerDraft?: V4ComposerDraft,
  updateComposerContent?: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void,
  submissionReady = true,
) {
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  let ownedDraft = composerDraft ??
    readV4ComposerDraft("/workspace", undefined, scopeId) ?? {
      text: "",
      updatedAt: 0,
    };
  const persistOwnedContent =
    updateComposerContent ??
    ((content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      ownedDraft = { ...ownedDraft, ...content };
      persistV4ComposerDraft("/workspace", undefined, scopeId, ownedDraft);
    });
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: TEST_LOCALE },
    createElement(ConversationComposer, {
      draftMode: sessionId === null,
      onSelectModel: vi.fn(),
      onSelectThought: vi.fn(),
      onSendText,
      createSubmissionFromComposer,
      submissionReady,
      composerDraft: ownedDraft,
      updateComposerContent: persistOwnedContent,
      replaceComposerDraft: (next) => {
        ownedDraft = { ...next, updatedAt: Date.now() };
        persistV4ComposerDraft("/workspace", undefined, scopeId, ownedDraft);
      },
      onStop: vi.fn(),
      onSwitchMode: vi.fn(),
      provider: undefined,
      sessionId,
      skillCatalogSessionId,
      snapshot: null,
      telemetryDraftConfig,
      workspacePath: "/workspace",
    }),
  );
}

function renderComposer(
  onSendText: (text: string, options?: unknown) => Promise<ConversationComposerSendResult | void>,
  telemetryDraftConfig?: {
    mode?: string;
    model?: string;
    provider?: string;
  },
) {
  const container = installMinimalDom();
  const root: Root = createRoot(container);
  act(() => {
    root.render(renderComposerElement(onSendText, null, telemetryDraftConfig));
  });
  return {
    rerenderSession: (sessionId: string) => {
      act(() => root.render(renderComposerElement(onSendText, sessionId)));
    },
    root,
  };
}

afterEach(() => {
  chatPromptEditorProps.length = 0;
  attachmentState.hasUnreadyAttachments = false;
  attachmentState.adoptSentAttachments.mockClear();
  attachmentState.prepareForSend.mockClear();
  attachmentState.prepareForSend.mockResolvedValue([]);
  inputClear.mockClear();
  inputSetText.mockClear();
  dialogOpenStates.length = 0;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationComposer prompt history", () => {
  it("a real editor text change advances the draft revision, protecting late recommended prompts", async () => {
    const { root } = renderComposer(vi.fn(async () => {}));
    const revisionBefore = getComposerDraftRevision("/workspace");
    const onChange = chatPromptEditorProps.at(-1)?.onChange;

    await act(async () => {
      (onChange as (value: string) => void)("user is typing");
    });

    expect(getComposerDraftRevision("/workspace")).toBe(revisionBefore + 1);
    await act(async () => root.unmount());
  });

  it("the draft prewarm session is passed to the input area only as the skill catalog authority", async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        renderComposerElement(
          vi.fn(async () => {}),
          null,
          undefined,
          "prewarm-a",
        ),
      );
    });

    expect(chatPromptEditorProps.at(-1)).toMatchObject({
      taskId: null,
      skillCatalogSessionId: "prewarm-a",
    });
    await act(async () => root.unmount());
  });

  it("builds the send telemetry seed from the frozen draft config even before the prewarm snapshot arrives", async () => {
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText, {
      mode: "build",
      model: "deepseek-v4-flash",
      provider: "e2e-deepseek",
    });
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("send the draft now");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith(
      "send the draft now",
      expect.objectContaining({
        telemetrySeed: expect.objectContaining({
          extraDetail: expect.objectContaining({
            ask_mode: "build",
            model_name: "custom:e2e-deepseek:deepseek-v4-flash",
            model_provider: "e2e-deepseek",
          }),
        }),
      }),
    );

    await act(async () => root.unmount());
  });

  it("with non-ready attachments submit does not send and does not call the final attachment submission entry", async () => {
    attachmentState.hasUnreadyAttachments = true;
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("must not send early");
      await flushAsyncWork();
    });

    expect(attachmentState.prepareForSend).not.toHaveBeenCalled();
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(onSendText).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("switching models while attachments become ready: the request still uses the selection from the moment send was clicked", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const onSendText = vi.fn(async () => {});
    let composer: ComposerSubmissionConfig = {
      mode: "build",
      modelSelection: {
        providerId: "provider-a",
        modelId: "shared-model",
        options: { reasoningLevel: "high" },
      },
    };
    const readSubmission = vi.fn(() => structuredClone(composer));
    let finishAttachments!: (value: []) => void;
    attachmentState.prepareForSend.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          finishAttachments = resolve;
        }),
    );
    act(() =>
      root.render(renderComposerElement(onSendText, null, undefined, null, readSubmission)),
    );
    const submit = chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean;
    await act(async () => {
      submit("freeze this selection");
      await flushAsyncWork();
    });
    expect(readSubmission).toHaveBeenCalledTimes(1);
    expect(onSendText).not.toHaveBeenCalled();
    composer = {
      mode: "yolo",
      modelSelection: {
        providerId: "provider-b",
        modelId: "shared-model",
        options: { reasoningLevel: "low" },
      },
    };
    await act(async () => {
      finishAttachments([]);
      await flushAsyncWork();
    });
    expect(readSubmission).toHaveBeenCalledTimes(1);
    expect(onSendText).toHaveBeenCalledWith(
      "freeze this selection",
      expect.objectContaining({
        submission: {
          mode: "build",
          modelSelection: {
            providerId: "provider-a",
            modelId: "shared-model",
            options: { reasoningLevel: "high" },
          },
        },
      }),
    );
    await act(async () => root.unmount());
  });

  it("submits are disabled while model or reasoning selection is incomplete, and the text is kept", async () => {
    const onSendText = vi.fn(async () => {});
    const container = installMinimalDom();
    const root = createRoot(container);
    act(() =>
      root.render(
        renderComposerElement(
          onSendText,
          "session-a",
          undefined,
          null,
          () => null,
          undefined,
          undefined,
          false,
        ),
      ),
    );

    expect(chatPromptEditorProps.at(-1)?.submitDisabled).toBe(true);
    await act(async () => {
      (chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean)(
        "waiting for selection completion",
      );
      await flushAsyncWork();
    });

    expect(onSendText).not.toHaveBeenCalled();
    expect(inputClear).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("a successful send deletes the persisted draft while memory keeps the current mode and model selection", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const selection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    };
    let draft: V4ComposerDraft = {
      text: "will be sent",
      mode: "yolo",
      modelSelection: selection,
      updatedAt: 1,
    };
    persistV4ComposerDraft("/workspace", undefined, "session-a", draft);
    const updateContent = vi.fn(
      (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
        draft = { ...draft, ...content };
        persistV4ComposerDraft("/workspace", undefined, "session-a", draft);
      },
    );
    act(() =>
      root.render(
        renderComposerElement(
          vi.fn(async () => {}),
          "session-a",
          undefined,
          null,
          () => ({ mode: "yolo", modelSelection: selection }),
          draft,
          updateContent,
        ),
      ),
    );
    await act(async () => {
      (chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean)("will be sent");
      await flushAsyncWork();
    });
    expect(readV4ComposerDraft("/workspace", undefined, "session-a")).toBeNull();
    expect(draft).toMatchObject({
      text: "",
      mode: "yolo",
      modelSelection: selection,
    });
    await act(async () => root.unmount());
  });

  it("a late send success must not clear new text written while waiting", async () => {
    let resolveSend!: () => void;
    const onSendText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean;
    const onChange = chatPromptEditorProps.at(-1)!.onChange as (text: string) => void;
    inputClear.mockClear();
    await act(async () => {
      submit("first message");
      await flushAsyncWork();
    });
    await act(async () => onChange("next message"));
    await act(async () => {
      resolveSend();
      await flushAsyncWork();
    });
    expect(inputClear).not.toHaveBeenCalled();
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe(
      "next message",
    );
    await act(async () => root.unmount());
  });

  it("when the second gate returns null the editor is kept and nothing is sent", async () => {
    attachmentState.prepareForSend.mockResolvedValueOnce(null);
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("boundary check again");
      await flushAsyncWork();
    });

    expect(attachmentState.prepareForSend).toHaveBeenCalledTimes(1);
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(onSendText).not.toHaveBeenCalled();
    expect(inputClear).not.toHaveBeenCalled();
    expect(readPromptHistoryEntries("/workspace")).toEqual([]);

    await act(async () => root.unmount());
  });

  it("writes submitted text to localStorage before an accepted send can promote away the draft composer", async () => {
    let resolveSend: (() => void) | undefined;
    const onSendText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    expect(typeof submit).toBe("function");

    await act(async () => {
      (submit as (value: string) => boolean)("you answer 1");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith("you answer 1", expectedTelemetrySendOptions());
    expect(readPromptHistoryEntries("/workspace")).toEqual(["you answer 1"]);

    await act(async () => {
      root.unmount();
      resolveSend?.();
      await flushAsyncWork();
    });
  });

  it("restores the previous localStorage prompt history when send fails", async () => {
    const onSendText = vi.fn(async () => {
      throw new Error("send failed");
    });
    const { root } = renderComposer(onSendText);
    persistPromptHistoryEntries("/workspace", ["previous message"]);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    expect(typeof submit).toBe("function");

    await act(async () => {
      (submit as (value: string) => boolean)("the failing message");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith("the failing message", expectedTelemetrySendOptions());
    expect(readPromptHistoryEntries("/workspace")).toEqual(["previous message"]);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the editor draft and prompt history untouched when a product guard blocks send", async () => {
    const onSendText = vi.fn(async () => "blocked" as const);
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("/goal keep this input");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith(
      "/goal keep this input",
      expectedTelemetrySendOptions(),
    );
    expect(inputClear).not.toHaveBeenCalled();
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(readPromptHistoryEntries("/workspace")).toEqual([]);
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe(
      "/goal keep this input",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("opens paused-queue confirmation without adopting the draft or prompt history", async () => {
    const onSendText = vi.fn(async () => "confirmationRequired" as const);
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("message awaiting confirmation");
      await flushAsyncWork();
    });

    expect(dialogOpenStates.at(-1)).toBe(true);
    expect(inputClear).not.toHaveBeenCalled();
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(readPromptHistoryEntries("/workspace")).toEqual([]);
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe(
      "message awaiting confirmation",
    );

    await act(async () => root.unmount());
  });

  it("does not persist a consecutive duplicate after trimming outer whitespace", async () => {
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText);
    const firstSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (firstSubmit as (value: string) => boolean)("duplicate message");
      await flushAsyncWork();
    });

    const setItem = vi.mocked(window.localStorage.setItem);
    setItem.mockClear();
    const duplicateSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (duplicateSubmit as (value: string) => boolean)("  duplicate message  ");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenNthCalledWith(
      2,
      "duplicate message",
      expectedTelemetrySendOptions(),
    );
    expect(readPromptHistoryEntries("/workspace")).toEqual(["duplicate message"]);
    expect(setItem).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not write or roll back history when a consecutive duplicate send fails", async () => {
    const onSendText = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("send failed"));
    const { root } = renderComposer(onSendText);
    const firstSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (firstSubmit as (value: string) => boolean)("duplicate message");
      await flushAsyncWork();
    });

    const setItem = vi.mocked(window.localStorage.setItem);
    setItem.mockClear();
    const duplicateSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (duplicateSubmit as (value: string) => boolean)("duplicate message");
      await flushAsyncWork();
    });

    expect(readPromptHistoryEntries("/workspace")).toEqual(["duplicate message"]);
    expect(setItem).not.toHaveBeenCalledWith(
      getPromptHistoryStorageKey("/workspace"),
      expect.any(String),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not restore the submitted draft while the composer is promoted to a session", async () => {
    let resolveSend: (() => void) | undefined;
    const onSendText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { rerenderSession, root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("first message");
      await flushAsyncWork();
    });

    rerenderSession("session-1");
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)).toBeNull();

    await act(async () => {
      resolveSend?.();
      await flushAsyncWork();
    });

    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});

// ── R3A-B-07: settlement after ACK loss + composer unmount/remount during disconnect ──
const REMOUNT_SESSION_ID = "sess_remount";
const REMOUNT_COMMAND_ID = "cmd_remount_1";
const REMOUNT_TEXT = "E2E_R3_ACK_LOSS_ACK please reply";

function authoritativeSnapshot(): ConversationSnapshot {
  return {
    sessionId: REMOUNT_SESSION_ID,
    queue: { items: [] },
    rows: {
      window: [
        {
          kind: "userInput",
          rowId: "row-1",
          sourceCommandId: REMOUNT_COMMAND_ID,
          text: REMOUNT_TEXT,
        },
      ],
    },
  } as unknown as ConversationSnapshot;
}

/** Draft object owned by the test itself, equivalent to the composerDraft held by useDraftConfigControl and surviving across component instances. */
function createDraftOwner() {
  const owner = {
    draft: { text: "", updatedAt: 0 } as V4ComposerDraft,
    writes: [] as string[],
    update(content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) {
      owner.draft = { ...owner.draft, editorStateJson: undefined, mention: undefined, ...content };
      owner.writes.push(content.text);
    },
  };
  return owner;
}

function mountRemountSession(
  onSendText: (text: string, options?: unknown) => Promise<void>,
  owner: ReturnType<typeof createDraftOwner>,
  existingContainer?: Element,
) {
  const container = existingContainer ?? installMinimalDom();
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      renderComposerElement(
        onSendText,
        REMOUNT_SESSION_ID,
        undefined,
        undefined,
        undefined,
        owner.draft,
        (content) => owner.update(content),
      ),
    );
  });
  return { root, container };
}

/** onSendText first reports the commandId, then suspends until the test decides the transport outcome. */
function makePendingSend() {
  let reject: (error: Error) => void = () => {};
  const pending = new Promise<void>((_resolve, rej) => {
    reject = rej;
  });
  const onSendText = vi.fn(async (_text: string, options?: unknown) => {
    (options as { onCommandCreated?: (id: string) => void }).onCommandCreated?.(REMOUNT_COMMAND_ID);
    await pending;
  });
  return { onSendText, reject };
}

async function typeAndSubmitRemountText(text = REMOUNT_TEXT) {
  const props = chatPromptEditorProps.at(-1)!;
  await act(async () => {
    (props.onChange as (value: string) => void)(text);
  });
  await act(async () => {
    (props.onSubmit as (value: string) => boolean)(text);
    await flushAsyncWork();
  });
}

/** Simulates a remote ChannelClient.dispose() rejecting in-flight RPCs. */
async function closeTransport(reject: (error: Error) => void) {
  await act(async () => {
    const error = new Error("ChannelClient disposed");
    error.name = "ConnectionClosed";
    reject(error);
    await flushAsyncWork();
  });
}

async function applyAuthoritativeSnapshot() {
  await act(async () => {
    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot());
    await flushAsyncWork();
  });
}

async function submitAndLoseTransport() {
  const owner = createDraftOwner();
  const { onSendText, reject } = makePendingSend();
  const { root, container } = mountRemountSession(onSendText, owner);
  await typeAndSubmitRemountText();
  expect(onSendText).toHaveBeenCalledTimes(1);
  // claimSubmittedDraft: the draft store is claimed and cleared first.
  expect(owner.writes.at(-1)).toBe("");
  await closeTransport(reject);
  // catch → restoreSubmittedDraft: the text is written back to the draft store; the editor is not cleared.
  expect(owner.writes.at(-1)).toBe(REMOUNT_TEXT);
  expect(inputClear).not.toHaveBeenCalled();
  return { owner, root, container };
}

describe("ConversationComposer settles submissions across pane remount (R3A-B-07)", () => {
  it("control: while the composer stays mounted, the authoritative projection can still clear the text after the transport closes", async () => {
    const { owner, root } = await submitAndLoseTransport();
    await applyAuthoritativeSnapshot();
    expect(inputClear).toHaveBeenCalledTimes(1);
    expect(owner.writes.at(-1)).toBe("");
    await act(async () => root.unmount());
  });

  it("after unmount/remount during disconnect, the arriving authoritative projection clears the refilled text and draft", async () => {
    const { owner, root, container } = await submitAndLoseTransport();
    // Disconnect: V4PaneConversationProvider returns null when rpcReady=false → SessionPane/composer unmount.
    await act(async () => root.unmount());
    inputClear.mockClear();
    inputSetText.mockClear();

    // Reconnect: remount; the text is refilled into the editor from the draft store.
    const { root: remounted } = mountRemountSession(
      vi.fn(async () => {}),
      owner,
      container,
    );
    await act(async () => {
      await flushAsyncWork();
    });
    expect(inputSetText).toHaveBeenCalledWith(REMOUNT_TEXT);

    await applyAuthoritativeSnapshot();
    expect(inputClear).toHaveBeenCalledTimes(1);
    expect(owner.draft.text).toBe("");
    await act(async () => remounted.unmount());
  });

  it("when the authoritative projection arrives before remount, the remounted composer clears the refilled text synchronously", async () => {
    const { owner, root, container } = await submitAndLoseTransport();
    await act(async () => root.unmount());
    await applyAuthoritativeSnapshot();
    inputClear.mockClear();

    const { root: remounted } = mountRemountSession(
      vi.fn(async () => {}),
      owner,
      container,
    );
    await act(async () => {
      await flushAsyncWork();
    });
    expect(inputClear).toHaveBeenCalledTimes(1);
    expect(owner.draft.text).toBe("");
    await act(async () => remounted.unmount());
  });

  it("after remount with user-edited text, a late authoritative projection must not clear the new input", async () => {
    const { owner, root, container } = await submitAndLoseTransport();
    await act(async () => root.unmount());
    inputClear.mockClear();

    const { root: remounted } = mountRemountSession(
      vi.fn(async () => {}),
      owner,
      container,
    );
    await act(async () => {
      await flushAsyncWork();
    });
    const props = chatPromptEditorProps.at(-1)!;
    await act(async () => {
      (props.onChange as (value: string) => void)(`${REMOUNT_TEXT} extra`);
    });

    await applyAuthoritativeSnapshot();
    expect(inputClear).not.toHaveBeenCalled();
    expect(owner.draft.text).toBe(`${REMOUNT_TEXT} extra`);
    await act(async () => remounted.unmount());
  });

  it("when the command settles as failed, the remounted composer keeps the text for the user to retry", async () => {
    const envelope = {
      commandId: REMOUNT_COMMAND_ID,
      clientId: "client-1",
      sessionId: REMOUNT_SESSION_ID,
      type: "sendText",
      payload: { text: REMOUNT_TEXT },
      issuedAt: Date.now(),
    } as unknown as CommandEnvelope;
    pendingCommandRegistry.record(envelope);
    const { owner, root, container } = await submitAndLoseTransport();
    await act(async () => root.unmount());
    inputClear.mockClear();

    const { root: remounted } = mountRemountSession(
      vi.fn(async () => {}),
      owner,
      container,
    );
    await act(async () => {
      await flushAsyncWork();
    });
    await act(async () => {
      pendingCommandRegistry.applyAck(envelope, {
        commandId: REMOUNT_COMMAND_ID,
        status: "failed",
        reasonCode: "guard.rejected",
        revisionAtDecision: 1,
      } as unknown as CommandAck);
      await flushAsyncWork();
    });
    expect(inputClear).not.toHaveBeenCalled();
    expect(owner.draft.text).toBe(REMOUNT_TEXT);
    await act(async () => remounted.unmount());
  });
});

// Conflict-integration regression: once the projection has taken over the submission, a transport failure
// while attachment adoption is still pending must not restore the old text; otherwise accepted input would
// reappear in the outgoing draft.
it("once the authoritative projection starts adopting attachments, a transport failure must not restore the submitted text", async () => {
  let completeAdoption = () => {};
  attachmentState.adoptSentAttachments.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        completeAdoption = resolve;
      }),
  );
  const owner = createDraftOwner();
  const { onSendText, reject } = makePendingSend();
  const { root } = mountRemountSession(onSendText, owner);
  await typeAndSubmitRemountText();
  await applyAuthoritativeSnapshot();
  expect(attachmentState.adoptSentAttachments).toHaveBeenCalledOnce();
  await closeTransport(reject);
  try {
    expect(owner.draft.text).toBe("");
  } finally {
    await act(async () => {
      completeAdoption();
      await flushAsyncWork();
      root.unmount();
    });
  }
});
