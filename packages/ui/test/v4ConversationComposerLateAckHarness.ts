// Shared mounted harness for the late worktree reservation ACK suites. The vi.mock setup stays in
// each suite file (mocks are per test file); this module only renders the composer with them.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ConversationComposer,
  type ConversationComposerSendResult,
  type ConversationComposerProps,
} from "@/v4/ConversationComposer.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import {
  ComposerDraftWorktreeIntentContext,
  type ComposerDraftWorktreeIntent,
  type ComposerWorktreePreparationParams,
} from "@/v4/composer/composerDraftWorktreeIntent.js";

export function createMinimalElement(ownerDocument: Document, tagName = "div") {
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

export function createStorageMock(): Storage {
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
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } as Storage;
}

export function installMinimalDom() {
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

export function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface LateAckHarness {
  capturedPrepareSession: () =>
    | ((params: ComposerWorktreePreparationParams) => Promise<string>)
    | null;
  controls: {
    beginOutcome: { ok: true; sessionId: string } | { ok: false };
    rejectSend: boolean;
  };
  onPrepareWorktreeSession: ReturnType<typeof vi.fn>;
  sessionActivated: ReturnType<typeof vi.fn>;
  onSendText: ReturnType<typeof vi.fn>;
  rerender: (sessionId: string | null, draftText?: string) => void;
  resolveReservation: (sessionId: string) => void;
  root: Root;
}

export const replaceComposerDraftSpy = vi.fn();

export function renderLateAckComposer(
  options: {
    worktree?: boolean;
    onPrepareFirstSubmission?: ConversationComposerProps["onPrepareFirstSubmission"];
  } = {},
): LateAckHarness {
  const container = installMinimalDom();
  const root: Root = createRoot(container);
  const sessionActivated = vi.fn();
  let resolveReservation!: (sessionId: string) => void;
  const reservationAck = new Promise<string>((resolve) => {
    resolveReservation = resolve;
  });
  const captured: {
    prepareSession: ((params: ComposerWorktreePreparationParams) => Promise<string>) | null;
  } = { prepareSession: null };
  // Emulates SessionPane.prepareWorktreeSession: activation of the prepared session is decided
  // when the Host ACK lands, through the composer-provided shouldActivate owner check.
  const onPrepareWorktreeSession = vi.fn(
    async (
      _params: ComposerWorktreePreparationParams,
      options?: { shouldActivate: () => boolean },
    ) => {
      const sessionId = await reservationAck;
      if (!options || options.shouldActivate()) sessionActivated(sessionId);
      return sessionId;
    },
  );
  const intent: ComposerDraftWorktreeIntent = {
    workspaceKey: "/workspace",
    beginCreation: (async (_preview, prepareSession) => {
      captured.prepareSession = prepareSession;
      return controls.beginOutcome;
    }) as ComposerDraftWorktreeIntent["beginCreation"],
  } as ComposerDraftWorktreeIntent;
  const slot = { current: options.worktree === false ? null : intent };
  const controls = {
    beginOutcome: { ok: true, sessionId: "prepared-session-a" } as
      | {
          ok: true;
          sessionId: string;
        }
      | { ok: false },
    rejectSend: false,
  };
  const onSendText = vi.fn(async () => {
    if (controls.rejectSend) throw new Error("send dispatch failed");
    return {} as ConversationComposerSendResult | void;
  });
  const render = (sessionId: string | null, draftText?: string) => {
    const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
    const composerDraft: V4ComposerDraft = draftText
      ? { text: draftText, updatedAt: Date.now() }
      : (readV4ComposerDraft("/workspace", undefined, scopeId) ?? { text: "", updatedAt: 0 });
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        ComposerDraftWorktreeIntentContext.Provider,
        { value: slot },
        createElement(ConversationComposer, {
          draftMode: sessionId === null,
          onSelectModel: vi.fn(),
          onSelectThought: vi.fn(),
          onSendText,
          durableFirstSubmission: true,
          onPrepareFirstSubmission: options.onPrepareFirstSubmission,
          onPrepareWorktreeSession,
          onStop: vi.fn(),
          onSwitchMode: vi.fn(),
          provider: undefined,
          sessionId,
          snapshot: null,
          composerDraft,
          updateComposerContent: (content: { text: string }) => {
            persistV4ComposerDraft("/workspace", undefined, scopeId, {
              ...composerDraft,
              ...content,
            });
          },
          replaceComposerDraft: (next) => {
            replaceComposerDraftSpy(next);
            persistV4ComposerDraft("/workspace", undefined, scopeId, {
              ...next,
              updatedAt: Date.now(),
            });
          },
          submissionReady: true,
          workspacePath: "/workspace",
        }),
      ),
    );
  };
  act(() => {
    root.render(render(null));
  });
  return {
    capturedPrepareSession: () => captured.prepareSession,
    controls,
    onPrepareWorktreeSession,
    sessionActivated,
    onSendText,
    rerender: (sessionId, draftText) => {
      // Simulate the user having typed in the target chat: its draft is already persisted.
      if (draftText !== undefined) {
        persistV4ComposerDraft("/workspace", undefined, sessionId ?? V4_DRAFT_SCOPE_ROOT, {
          text: draftText,
        });
      }
      act(() => {
        root.render(render(sessionId, draftText));
      });
    },
    resolveReservation,
    root,
  };
}
