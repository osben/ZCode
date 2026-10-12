// Repro tests (ZCT-2092635483465441280 / ZCT-2092650540916523008 / ZCT-202608-C5F84801):
// when switching/opening a session, the scroll lands in a random spot in the middle of history —
// "neither the bottom nor the last reading position".
//
// The regression assertions are written against [expected behavior], locking down the two
// boundaries that used to cause random history landing spots:
// 1. Lease race: SessionPane switches sessions without remounting, and the lease arrives one beat
//    late in a useEffect, so scrollMemoryKey/sessionKey change first while rows still hold the old
//    session's content; the restore effect (ConversationTimeline.tsx's session-switch effect)
//    performs its pixel clamp in the old session's coordinate system, and once rows are swapped to
//    the new session (never passing through 0 rows within the 30s keep-warm window) the restore
//    does not re-run either.
// 2. Fragmented coordinate mismatch: the memory stores a pixel scrollTop from the
//    "full window x real measured heights" regime; a cold open only has the tail 60 rows plus a
//    72px estimate (heightCache cleared), so the clamped landing spot no longer corresponds to the
//    reading position at save time, and nothing re-anchors after the content is backfilled.
//
// Harness copied from v4ConversationTimelineScrollMemory.test.ts (minimal DOM + mocked virtualizer).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import {
  clearChatSessionScrollMemoryForTest,
  saveChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";

const layout = vi.hoisted(() => ({ clientHeight: 300, scrollHeight: 1200 }));
const virtualizer = vi.hoisted(() => ({
  getVirtualItemForOffset: vi.fn(),
  getTotalSize: () => layout.scrollHeight,
  getVirtualItems: () => [],
  measurementsCache: [] as Array<{
    end: number;
    index: number;
    key: string;
    lane: number;
    size: number;
    start: number;
  }>,
  measure: vi.fn(),
  measureElement: vi.fn(),
  scrollOffset: null as number | null,
  scrollRect: null as { height: number } | null,
  scrollToIndex: vi.fn(),
  shouldAdjustScrollPositionOnItemSizeChange: null as
    | null
    | ((item: { end: number; start: number }) => boolean),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => virtualizer,
}));

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnGroup: () => React.createElement("div"),
  };
});

vi.mock("@/v4/ConversationTurnNavigator.js", () => ({
  ConversationTurnNavigator: () => null,
}));

vi.mock("@/v4/useConversationTimelineFind.js", () => ({
  useConversationTimelineFind: () => undefined,
}));

type TestEventHandler = (event: Record<string, unknown>) => void;
type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  parentNode: TestElement | null;
  scrollTop: number;
};

let nextFrameId = 1;
const animationFrames = new Map<number, FrameRequestCallback>();
const scheduledMicrotasks: Array<() => void> = [];
const nativeQueueMicrotask = globalThis.queueMicrotask;
let mountedRoot: Root | null = null;

function createMinimalElement(ownerDocument: Document, tagName = "div"): TestElement {
  let scrollTop = 0;
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(type, [...(element.__listeners.get(type) ?? []), handler]);
    },
    appendChild: (child: TestElement) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestElement[],
    dispatchEvent: (event: Event) => {
      const forwardedEvent = {
        bubbles: event.bubbles,
        cancelBubble: event.cancelBubble,
        currentTarget: element,
        defaultPrevented: event.defaultPrevented,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        target: element,
        timeStamp: event.timeStamp,
        type: event.type,
      };
      for (const handler of element.__listeners.get(event.type) ?? []) {
        handler(forwardedEvent);
      }
      return !event.defaultPrevented;
    },
    getBoundingClientRect: () => ({
      bottom: layout.clientHeight,
      height: layout.clientHeight,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestElement, beforeChild?: TestElement | null) => {
      child.parentNode = element as unknown as TestElement;
      const index = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (index >= 0) element.childNodes.splice(index, 0, child);
      else element.childNodes.push(child);
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as TestElement | null,
    removeAttribute: (name: string) => element.__attrs.delete(name),
    removeChild: (child: TestElement) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    removeEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(
        type,
        (element.__listeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    querySelectorAll: () => [],
    setAttribute: (name: string, value: string) => {
      element.__attrs.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  Object.defineProperties(element, {
    clientHeight: { get: () => layout.clientHeight },
    scrollHeight: { get: () => layout.scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        // Matches the browser: assignment is clamped against the current content height.
        scrollTop = Math.min(
          Math.max(Number(value) || 0, 0),
          Math.max(layout.scrollHeight - layout.clientHeight, 0),
        );
      },
    },
  });
  return element as unknown as TestElement;
}

function installMinimalDom(): TestElement {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: () => {},
    cancelAnimationFrame: (frameId: number) => animationFrames.delete(frameId),
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    queueMicrotask: (callback: () => void) => scheduledMicrotasks.push(callback),
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      animationFrames.set(frameId, callback);
      return frameId;
    },
  };
  documentMock.defaultView = windowMock;
  Object.assign(globalThis, {
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    queueMicrotask: windowMock.queueMicrotask,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

function findByTestId(node: TestElement, testId: string): TestElement | null {
  if (node.getAttribute("data-testid") === testId) return node;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return null;
}

function flushAnimationFrame(): void {
  const frameIds = [...animationFrames.keys()];
  for (const frameId of frameIds) {
    const callback = animationFrames.get(frameId);
    if (!callback) continue;
    animationFrames.delete(frameId);
    callback(0);
  }
}

function flushScheduledMicrotasks(): void {
  while (scheduledMicrotasks.length > 0) {
    scheduledMicrotasks.shift()?.();
  }
}

function userInputRow(rowId: number): UserInputRow {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `message ${rowId}`,
    attachments: [],
  };
}

const rowContext: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function renderTimeline(
  root: Root,
  sessionKey: string,
  scrollMemoryKey: string | null,
  rows: readonly ConversationRow[],
  options: { canLoadOlder?: boolean; totalCount?: number } = {},
): void {
  root.render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationTimeline, {
        canLoadOlder: options.canLoadOlder,
        rows,
        totalCount: options.totalCount ?? rows.length,
        sessionKey,
        scrollMemoryKey,
        rowContext,
      }),
    ),
  );
}

const KEY_A = "workspace::pane:a::session:a";
const KEY_B = "workspace::pane:a::session:b";
const ROWS_A = [userInputRow(1), userInputRow(2), userInputRow(3)];
// The new session's tail window (rowIds only need to differ; the real scenario is the last 60 rows).
const ROWS_B_TAIL = [userInputRow(101), userInputRow(102), userInputRow(103)];

beforeEach(() => {
  clearChatSessionScrollMemoryForTest();
  layout.clientHeight = 300;
  layout.scrollHeight = 1200;
  nextFrameId = 1;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  virtualizer.getVirtualItemForOffset.mockReset();
  virtualizer.measurementsCache = [];
  virtualizer.measure.mockClear();
});

afterEach(() => {
  act(() => {
    flushScheduledMicrotasks();
    mountedRoot?.unmount();
    flushScheduledMicrotasks();
  });
  mountedRoot = null;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  globalThis.queueMicrotask = nativeQueueMicrotask;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("会话切换滚动恢复（ZCT 复现）", () => {
  it("lease 迟一拍时，恢复必须以新会话内容为坐标系，而不是把旧会话钳制值当成最终落点", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    // -- commit 0: viewing session A (no memory -> pinned to bottom).
    act(() => renderTimeline(mountedRoot!, "session-a", KEY_A, ROWS_A));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });
    expect(timeline.scrollTop).toBe(900); // A's bottom (1200 - 300)

    // Session B was left in an off-bottom reading state: the position is stored in B's full-window
    // coordinate system (scrollHeight=20000).
    saveChatSessionScrollMemoryState(KEY_B, {
      scrollTop: 5000,
      scrollHeight: 20000,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });

    // -- commit 1: SessionPane switches to B. sessionKey/scrollMemoryKey change immediately,
    // but the lease arrives one beat late in a useEffect -> rows still hold A's content
    // (SessionPane.tsx rows have no sessionLeaseReady guard). The restore effect runs at this
    // moment: clamp(5000, 1200-300)=900.
    act(() => renderTimeline(mountedRoot!, "session-b", KEY_B, ROWS_A));
    act(() => {
      flushAnimationFrame(); // restore correction rAF (rows are still A)
      flushAnimationFrame(); // release guard rAF
      flushScheduledMicrotasks();
    });

    // -- commit 2: the lease is in place and B is within keep-warm -> rows are swapped straight to
    // B's window, never passing through 0 rows; B's content height is 2400.
    act(() => {
      layout.scrollHeight = 2400;
      renderTimeline(mountedRoot!, "session-b", KEY_B, ROWS_B_TAIL);
    });
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });

    // Expected behavior: the restore must use B's actual content as its coordinate system ->
    // clamp(5000, 2400-300)=2100 (at minimum, replay the saved position in the new coordinate
    // system).
    // Pre-fix implementation: it stopped at commit 1's 900, clamped against A's content — neither
    // B's last position nor B's bottom (2100), i.e. the "lands in the middle of history" from the
    // ticket.
    expect(timeline.scrollTop).toBe(2100);
  });

  it("冷开时记忆的全量坐标像素被分片尾窗钳制后，内容补齐必须重新锚定回保存位置", () => {
    // Last leave: reading at 12000px inside the full window (20000px tall).
    saveChatSessionScrollMemoryState(KEY_B, {
      scrollTop: 12000,
      scrollHeight: 20000,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });

    // Cold open: only the tail fragment + a 72px estimate -> the content is only 1200px tall.
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    act(() =>
      renderTimeline(mountedRoot!, "session-b", KEY_B, ROWS_B_TAIL, {
        canLoadOlder: true,
        totalCount: 5,
      }),
    );
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });
    // The restore is clamped into the fragment's coordinate system: clamp(12000, 900)=900.
    expect(timeline.scrollTop).toBe(900);
    expect(timeline.getAttribute("data-following")).toBe("false");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).not.toBeNull();

    // History backfill + real measured heights complete: older rows are prepended and the total
    // height returns to 20000.
    act(() => {
      layout.scrollHeight = 20000;
      renderTimeline(
        mountedRoot!,
        "session-b",
        KEY_B,
        [userInputRow(1), userInputRow(2), ...ROWS_B_TAIL],
        { canLoadOlder: false, totalCount: 5 },
      );
    });
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });

    // Expected behavior: after the content is backfilled it must return to the saved reading
    // position of 12000.
    // Pre-fix implementation: prepend anchoring translated the anchor by treating "the row that
    // happened to be in the viewport at the clamp moment" as the reading anchor
    // (900 + 18800 = 19700), so the landing drifted to near the bottom / somewhere arbitrary in
    // history and the saved position was permanently lost.
    expect(timeline.scrollTop).toBe(12000);
  });
});
