// @vitest-environment jsdom
import { act, createElement, memo, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";

const probe = vi.hoisted(() => ({ renders: new Map<string, number>() }));

// The virtualizer reports the three historic turns as mounted items; the running turn is the
// normal-flow live tail and is not virtualized.
vi.mock("@tanstack/react-virtual", () => {
  const items = [0, 1, 2].map((index) => ({
    end: index * 100 + 100,
    index,
    key: `unit-${index}`,
    lane: 0,
    size: 100,
    start: index * 100,
  }));
  const virtualizer = {
    getVirtualItemForOffset: () => undefined,
    getTotalSize: () => 300,
    getVirtualItems: () => items,
    measurementsCache: items,
    measure: () => {},
    measureElement: () => {},
    resizeItem: () => {},
    scrollOffset: null,
    scrollRect: null,
    scrollToIndex: () => {},
    shouldAdjustScrollPositionOnItemSizeChange: null,
  };
  return { useVirtualizer: () => virtualizer };
});

// Counts renders of the turn group itself. The stub is memoized with the default shallow
// comparison, so a count only increases when the timeline hands it new props, which is the
// behavior under test.
vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  type Props = ComponentProps<typeof React.Fragment> & { unit: { turnId: string } };
  const ConversationTurnGroup = memo(function ConversationTurnGroupProbe(props: Props) {
    probe.renders.set(props.unit.turnId, (probe.renders.get(props.unit.turnId) ?? 0) + 1);
    return React.createElement("div", { "data-turn-id": props.unit.turnId });
  });
  return { ConversationTurnGroup };
});

vi.mock("@/v4/ConversationTurnNavigator.js", () => ({
  ConversationTurnNavigator: () => null,
}));

vi.mock("@/v4/useConversationTimelineFind.js", () => ({
  useConversationTimelineFind: () => undefined,
}));

function baseRow(
  rowId: number,
  turnId: string,
  overrides: Record<string, unknown>,
): ConversationRow {
  return {
    createdAt: 1_700_000_000_000 + rowId * 1_000,
    createdAtSeq: rowId,
    rowId,
    turnId,
    ...overrides,
  } as ConversationRow;
}

function historicTurn(base: number, turnId: string): ConversationRow[] {
  return [
    baseRow(base, turnId, {
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1_700_000_000_000 + base * 1_000,
      activeMs: 11_000,
    }),
    baseRow(base + 1, turnId, {
      kind: "userInput",
      origin: "realUser",
      text: `question ${turnId}`,
      attachments: [],
    }),
    baseRow(base + 2, turnId, {
      kind: "assistantText",
      state: "complete",
      text: `answer ${turnId}`,
    }),
  ];
}

const rows: ConversationRow[] = [
  ...historicTurn(1, "turn-a"),
  ...historicTurn(4, "turn-b"),
  ...historicTurn(7, "turn-c"),
  baseRow(10, "turn-live", {
    kind: "turnHeader",
    origin: "userInput",
    state: "running",
    startedAt: 1_700_000_010_000,
  }),
  baseRow(11, "turn-live", {
    kind: "userInput",
    origin: "realUser",
    text: "working",
    attachments: [],
  }),
];

const rowContext: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

// A session-level slot is attached to the first unit by withAfterFirstUserInputSlot, which spreads that unit on every rebuild.
const firstInputSlot = createElement("div", { "data-testid": "first-input-slot" });

let container: HTMLDivElement;
let root: Root;

function renderTimeline(): void {
  root.render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationTimeline, {
        rows,
        totalCount: rows.length,
        sessionKey: "session-1",
        scrollMemoryKey: null,
        rowContext,
        afterFirstUserInputSlot: firstInputSlot,
      }),
    ),
  );
}

function rendersOf(turnId: string): number {
  return probe.renders.get(turnId) ?? 0;
}

beforeEach(() => {
  probe.renders.clear();
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("ConversationTimeline clock ticks", () => {
  it("re-renders only the running turn while the elapsed clock advances", () => {
    act(() => renderTimeline());
    const historicBefore = ["turn-a", "turn-b", "turn-c"].map(rendersOf);
    const liveBefore = rendersOf("turn-live");

    expect(historicBefore.every((count) => count > 0)).toBe(true);
    expect(liveBefore).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(["turn-a", "turn-b", "turn-c"].map(rendersOf)).toEqual(historicBefore);
    expect(rendersOf("turn-live")).toBeGreaterThan(liveBefore);
  });
});
