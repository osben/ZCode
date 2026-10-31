// Shared mounted harness for the late worktree reservation ACK suites. The vi.mock setup stays in
// each suite file (mocks are per test file); this module only renders the composer with them.
import { act, createElement, useCallback } from "react";
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
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import {
  ComposerDraftWorktreeIntentContext,
  type ComposerDraftWorktreeIntent,
  type ComposerWorktreePreparationParams,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";

/**
 * The new-task draft is stored under its organization scope (the owner passes it on every write),
 * so suites that read or seed the root draft must pass the same scope.
 */
export const ROOT_DRAFT_SCOPE = resolveComposerScope(null);

type OwnerDraftProps =
  | "composerDraft"
  | "composerDraftScopeToken"
  | "stageComposerContent"
  | "captureComposerContentLifecycleCommit"
  | "captureComposerSubmissionDraftTransaction"
  | "persistComposerContent"
  | "updateComposerContent"
  | "replaceComposerDraft"
  | "draftConfig";

export type ComposerHarnessProps = Omit<ConversationComposerProps, OwnerDraftProps>;

/**
 * Feeds ConversationComposer the draft owner props exactly as SessionPane does, using the real
 * useDraftConfigControl owner. Tests that drive lifecycle commits or submission transactions
 * therefore exercise the same write paths as production.
 */
export function ComposerWithDraftOwner(props: ComposerHarnessProps) {
  const { workspacePath, sessionId = null, ...rest } = props;
  const owner = useDraftConfigControl({
    workspacePath,
    provider: undefined,
    sessionId,
    sessionConfig: null,
    agentStartupAllowed: false,
    modelSelectionService: null,
  });
  // SessionPane passes the owner's stable callback; a fresh closure here would re-run the composer's
  // scope-restore effect (it lists replaceComposerDraft as a dependency) on every harness render.
  const { replaceComposerDraft: ownerReplaceComposerDraft } = owner;
  const replaceComposerDraft = useCallback(
    (next: Omit<V4ComposerDraft, "updatedAt">) => {
      replaceComposerDraftSpy(next);
      ownerReplaceComposerDraft(next);
    },
    [ownerReplaceComposerDraft],
  );
  return createElement(ConversationComposer, {
    ...rest,
    workspacePath,
    sessionId,
    composerDraft: owner.composerDraft,
    composerDraftScopeToken: owner.composerDraftScopeToken,
    draftConfig: owner.draftConfig,
    stageComposerContent: owner.stageComposerContent,
    captureComposerContentLifecycleCommit: owner.captureComposerContentLifecycleCommit,
    captureComposerSubmissionDraftTransaction: owner.captureComposerSubmissionDraftTransaction,
    persistComposerContent: owner.persistComposerContent,
    updateComposerContent: owner.updateComposerContent,
    replaceComposerDraft,
  });
}

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
    focus: () => {
      (ownerDocument as { activeElement?: unknown }).activeElement = element;
    },
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
  /** Re-render the current view after mutating `controls`. */
  refresh: () => void;
  capturedPrepareSession: () =>
    | ((params: ComposerWorktreePreparationParams) => Promise<string>)
    | null;
  controls: {
    beginOutcome: { ok: true; sessionId: string } | { ok: false };
    rejectSend: boolean;
    /** While set, worktree beginCreation stays pending until resolve() — emulates a slow Host ACK. */
    beginGate: { promise: Promise<void>; resolve: () => void } | null;
    /** Snapshot handed to the composer on the next render (bound-session states). */
    snapshot: ConversationComposerProps["snapshot"];
    /** Ordinary session readiness handed to the composer on the next render. */
    submissionReady: boolean;
  };
  onPrepareWorktreeSession: ReturnType<typeof vi.fn>;
  sessionActivated: ReturnType<typeof vi.fn>;
  onSendText: ReturnType<typeof vi.fn>;
  rerender: (sessionId: string | null, draftText?: string) => void;
  resolveReservation: (sessionId: string) => void;
  root: Root;
  container: Element;
}

export const replaceComposerDraftSpy = vi.fn();

export function renderLateAckComposer(
  options: {
    worktree?: boolean;
    onPrepareFirstSubmission?: ConversationComposerProps["onPrepareFirstSubmission"];
    onFirstSubmissionReserved?: ConversationComposerProps["onFirstSubmissionReserved"];
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
      if (controls.beginGate) await controls.beginGate.promise;
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
    beginGate: null as { promise: Promise<void>; resolve: () => void } | null,
    snapshot: null as ConversationComposerProps["snapshot"],
    submissionReady: true,
  };
  const onSendText = vi.fn(async () => {
    if (controls.rejectSend) throw new Error("send dispatch failed");
    return {} as ConversationComposerSendResult | void;
  });
  const render = (sessionId: string | null, draftText?: string) => {
    if (draftText !== undefined) {
      // A draft typed in another scope before this render; the owner reads it on mount.
      persistV4ComposerDraft(
        "/workspace",
        undefined,
        sessionId ?? V4_DRAFT_SCOPE_ROOT,
        {
          text: draftText,
          updatedAt: Date.now(),
        },
        ROOT_DRAFT_SCOPE,
      );
    }
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        ComposerDraftWorktreeIntentContext.Provider,
        { value: slot },
        createElement(ComposerWithDraftOwner, {
          draftMode: sessionId === null,
          onSelectModel: vi.fn(),
          onSelectThought: vi.fn(),
          onSendText,
          durableFirstSubmission: true,
          onPrepareFirstSubmission: options.onPrepareFirstSubmission,
          onFirstSubmissionReserved: options.onFirstSubmissionReserved,
          onPrepareWorktreeSession,
          onStop: vi.fn(),
          onSwitchMode: vi.fn(),
          provider: undefined,
          sessionId,
          snapshot: controls.snapshot,
          submissionReady: controls.submissionReady,
          workspacePath: "/workspace",
        }),
      ),
    );
  };
  let currentSessionId: string | null = null;
  act(() => {
    root.render(render(null));
  });
  return {
    refresh: () => {
      act(() => {
        root.render(render(currentSessionId));
      });
    },
    capturedPrepareSession: () => captured.prepareSession,
    controls,
    onPrepareWorktreeSession,
    sessionActivated,
    onSendText,
    rerender: (sessionId, draftText) => {
      // Simulate the user having typed in the target chat: its draft is already persisted.
      if (draftText !== undefined) {
        persistV4ComposerDraft(
          "/workspace",
          undefined,
          sessionId ?? V4_DRAFT_SCOPE_ROOT,
          {
            text: draftText,
          },
          ROOT_DRAFT_SCOPE,
        );
      }
      currentSessionId = sessionId;
      act(() => {
        root.render(render(sessionId, draftText));
      });
    },
    resolveReservation,
    root,
    container,
  };
}

type MinimalNode = {
  attributes?: Map<string, string>;
  childNodes?: MinimalNode[];
  [key: string]: unknown;
};

/** React props of the first rendered element carrying `data-testid` (the minimal DOM has no queries). */
export function findReactPropsByTestId(
  container: Element,
  testId: string,
): Record<string, unknown> | null {
  const visit = (node: MinimalNode): Record<string, unknown> | null => {
    if (node.attributes?.get("data-testid") === testId) {
      const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
      return key ? (node[key] as Record<string, unknown>) : null;
    }
    for (const child of node.childNodes ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(container as unknown as MinimalNode);
}
