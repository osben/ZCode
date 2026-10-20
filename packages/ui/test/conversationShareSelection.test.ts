// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip.js";
const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversation partial share selection store", () => {
  beforeEach(async () => {
    const { useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    useConversationShareSelectionStore.getState().resetForTests();
  });

  it("selects all turns by default on first open and keeps newly synced candidates selected", async () => {
    const {
      getConversationShareDraft,
      getConversationShareSelectedRowIds,
      useConversationShareSelectionStore,
    } = await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.openShare("task-a");
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").open,
    ).toBe(true);
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").accessMode,
    ).toBe("public_importable");
    store.syncAvailableTurns(
      "task-a",
      [11, 22].map((rowId) => ({ rowId, productTurnId: String(rowId) })),
    );
    store.beginSelectionEdit("task-a");
    store.togglePendingRow("task-a", 22);
    store.confirmSelectionEdit("task-a");
    store.syncAvailableTurns(
      "task-a",
      [5, 11, 22].map((rowId) => ({ rowId, productTurnId: String(rowId) })),
    );

    expect(
      getConversationShareSelectedRowIds(useConversationShareSelectionStore.getState(), "task-a"),
    ).toEqual([5, 11]);
  });

  it("deselects a whole product turn by productTurnId: same-turn queries go together, other turns stay", async () => {
    const {
      getConversationShareSelectedProductTurnIds,
      getConversationShareSelectedRowIds,
      useConversationShareSelectionStore,
    } = await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.openShare("task-a");
    // product-turn-1 has two steer queries; the catalog lists two items, but deselecting the turn must affect the whole turn.
    store.syncAvailableTurns("task-a", [
      { rowId: 11, productTurnId: "product-turn-1" },
      { rowId: 12, productTurnId: "product-turn-1" },
      { rowId: 21, productTurnId: "product-turn-2" },
    ]);

    store.deselectProductTurn("task-a", "product-turn-1");

    let state = useConversationShareSelectionStore.getState();
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([21]);
    expect(getConversationShareSelectedProductTurnIds(state, "task-a")).toEqual(["product-turn-2"]);

    // Idempotent: repeated deselect keeps state and never flips excluded rows back (old toggle-semantics bug).
    store.deselectProductTurn("task-a", "product-turn-1");
    state = useConversationShareSelectionStore.getState();
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([21]);
  });

  it("keeps the user-chosen share access mode when entering partial selection", async () => {
    const { getConversationShareDraft, useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setAccessMode("task-a", "public_importable");
    store.openShare("task-a");

    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").accessMode,
    ).toBe("public_importable");
  });
});

describe("ConversationShareSelectionPanel", () => {
  it("computes the panel max height from the live positions of the conversation container and bottom dock", async () => {
    const {
      CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY,
      CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY,
      resolveConversationShareSelectionPanelLayout,
      syncConversationShareSelectionPanelLayout,
    } = await import("@/v4/conversationShareSelectionPanelLayout.js");

    expect(
      resolveConversationShareSelectionPanelLayout({
        containerHeightPx: 891,
        dockStartPx: 647,
      }),
    ).toEqual({
      centerYPx: 327.5,
      maxHeightPx: 607,
      topPx: 24,
      bottomPx: 631,
    });
    expect(
      resolveConversationShareSelectionPanelLayout({
        containerHeightPx: 1200,
        dockStartPx: 1000,
      }),
    ).toEqual({
      centerYPx: 504,
      maxHeightPx: 960,
      topPx: 24,
      bottomPx: 984,
    });
    const expanded = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 1200,
      dockStartPx: 1000,
    });
    const shrunk = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 700,
      dockStartPx: 500,
    });
    expect(expanded.maxHeightPx).toBeGreaterThan(shrunk.maxHeightPx);
    expect(shrunk.bottomPx).toBeLessThanOrEqual(484);

    // On a short viewport / high dock, reclaim the top safe margin first, then keep a minimum height; never collapse to a zero-height sliver.
    const collided = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 400,
      dockStartPx: 100,
    });
    expect(collided.topPx).toBe(0);
    expect(collided.maxHeightPx).toBe(120);

    // When the container itself is shorter than the minimum height, the panel must still stay inside it.
    const tiny = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 100,
      dockStartPx: 60,
    });
    expect(tiny.maxHeightPx).toBe(52);
    expect(tiny.bottomPx).toBeLessThanOrEqual(100);

    const container = document.createElement("div");
    const dock = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 53,
      left: 0,
      top: 53,
      right: 1241,
      bottom: 944,
      width: 1241,
      height: 891,
      toJSON: () => ({}),
    });
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 700,
      left: 0,
      top: 700,
      right: 1241,
      bottom: 944,
      width: 1241,
      height: 244,
      toJSON: () => ({}),
    });

    syncConversationShareSelectionPanelLayout(container, dock);

    expect(
      container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY),
    ).toBe("607px");
    expect(
      container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY),
    ).toBe("327.5px");
  });

  it("maps the halved visible thumb onto the full track", async () => {
    const { resolveConversationShareScrollbarIndicatorMetrics } =
      await import("@/v4/conversationShareScrollbarMetrics.js");
    const input = {
      trackSize: 400,
      viewportSize: 400,
      contentSize: 800,
    };

    expect(
      resolveConversationShareScrollbarIndicatorMetrics({ ...input, scrollOffset: 0 }),
    ).toEqual({ visible: true, size: 100, offset: 0 });
    expect(
      resolveConversationShareScrollbarIndicatorMetrics({ ...input, scrollOffset: 200 }),
    ).toEqual({ visible: true, size: 100, offset: 150 });
    expect(
      resolveConversationShareScrollbarIndicatorMetrics({ ...input, scrollOffset: 400 }),
    ).toEqual({ visible: true, size: 100, offset: 300 });
  });

  it("toggles through checkbox, summary and row while the locate action only inspects", async () => {
    const { ConversationShareSelectionPanel } =
      await import("@/v4/ConversationShareSelectionPanel.js");
    const onToggle = vi.fn();
    const onInspect = vi.fn();
    const items = [
      {
        key: "turn-1:query:11",
        turnId: "turn-1",
        unitIndex: 0,
        rowId: 11,
        userPreview: "First user question",
        assistantPreview: "First answer summary",
        assistantPreviewKind: "text" as const,
        isRunning: false,
      },
      {
        key: "turn-2:query:22",
        turnId: "turn-2",
        unitIndex: 1,
        rowId: 22,
        userPreview: "Second user question",
        assistantPreview: "Second answer summary",
        assistantPreviewKind: "text" as const,
        isRunning: false,
      },
    ];

    render(
      createElement(ConversationShareSelectionPanel, {
        visible: true,
        items,
        selectedRowIds: new Set([11]),
        onToggle,
        onInspect,
      }),
    );

    const panel = screen.getByTestId("conversation-share-selection-panel");
    expect(screen.queryByRole("button", { name: "conversationShare.selection.close" })).toBeNull();
    expect(panel.getAttribute("data-conversation-share-keep-open")).toBeNull();

    const summaryButton = screen.getByRole("button", { name: "First user question" });
    const firstItem = summaryButton.parentElement;
    expect(firstItem?.getAttribute("data-conversation-share-selection-state")).toBe("selected");

    const secondSummaryButton = screen.getByRole("button", {
      name: "Second user question",
    });
    const secondItem = secondSummaryButton.parentElement;
    expect(secondItem?.getAttribute("data-conversation-share-selection-state")).toBe("unselected");

    const checkboxHitAreas = panel.querySelectorAll(
      '[data-conversation-share-checkbox-hit-area="true"]',
    );
    expect(checkboxHitAreas).toHaveLength(2);

    fireEvent.click(checkboxHitAreas[0]!);
    expect(onToggle).toHaveBeenCalledWith(11);
    expect(onInspect).not.toHaveBeenCalled();

    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(summaryButton);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onInspect).not.toHaveBeenCalled();
    fireEvent.click(firstItem!);
    expect(onToggle).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getAllByTestId("conversation-share-selection-locate")[0]!);
    expect(onToggle).toHaveBeenCalledTimes(3);
    expect(onInspect).toHaveBeenCalledWith({ unitIndex: 0, rowId: 11 });
  });
});

describe("ConversationShareConfirmationDock", () => {
  it("popover uses the range button to adjust content; close and confirm each trigger their callback", async () => {
    const { ConversationShareConfirmationDock } =
      await import("@/v4/ConversationShareConfirmationDock.js");
    const onCancel = vi.fn(),
      onEditSelection = vi.fn(),
      onConfirm = vi.fn();
    render(
      createElement(ConversationShareConfirmationDock, {
        title: "分享标题",
        selectedCount: 3,
        totalCount: 5,
        disclosureAccepted: true,
        onCancel,
        onEditSelection,
        onConfirm,
      }),
    );
    expect(screen.getByTestId("conversation-share-confirmation-header").textContent).toContain(
      "conversationShare.popover.title",
    );
    fireEvent.click(screen.getByTestId("conversation-share-range-summary"));
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.result.dismiss" }));
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(onEditSelection).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("conversation-share-back")).toBeNull();
  });
});

describe("ConversationSharePreflightStatus", () => {
  it("shows only preflight diagnostics and issue actions; the checking state lives on the range button", async () => {
    const { ConversationSharePreflightStatus } =
      await import("@/conversation-share-interaction/ConversationSharePreflightStatus.js");
    const common = {
      onDeselectTurn: vi.fn(),
    };
    const { rerender } = render(
      createElement(ConversationSharePreflightStatus, {
        ...common,
        preflight: { status: "checking" },
      }),
    );
    expect(screen.queryByTestId("conversation-share-selection-preflight-status")).toBeNull();
    expect(screen.queryByTestId("conversation-share-next")).toBeNull();

    rerender(
      createElement(ConversationSharePreflightStatus, {
        ...common,
        preflight: {
          status: "ready",
          revision: 7,
          logEpoch: "epoch-1",
          capabilitiesFingerprint: "fingerprint",
          blockingIssues: [
            // turnOrdinal is only used for copy; deselecting the turn targets by productTurnId.
            {
              code: "running_turn",
              scope: "turn",
              turnOrdinal: 2,
              productTurnId: "product-turn-2",
            },
          ],
          skippableWarnings: [],
          deferredIssues: [],
          supportedArtifactTypes: [],
          turnResults: [],
        },
      }),
    );
    fireEvent.click(screen.getByTestId("conversation-share-selection-preflight-status"));
    expect(
      await screen.findByTestId("conversation-share-selection-preflight-popover"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.issue.deselectTurn" }));
    expect(common.onDeselectTurn).toHaveBeenCalledWith("product-turn-2");

    rerender(
      createElement(ConversationSharePreflightStatus, {
        ...common,
        preflight: {
          status: "ready",
          revision: 7,
          logEpoch: "epoch-1",
          capabilitiesFingerprint: "fingerprint",
          blockingIssues: [],
          skippableWarnings: [
            {
              code: "artifact_type_not_allowed",
              scope: "artifact",
              turnOrdinal: 1,
              artifactDisplayName: "video.mp4",
              artifactType: "mp4",
            },
          ],
          deferredIssues: [],
          supportedArtifactTypes: [],
          turnResults: [],
        },
      }),
    );
    expect(screen.getByTestId("conversation-share-selection-preflight-status")).toBeTruthy();
  });

  it("transport-level blocks offer a re-check entry; turn-level blocks still only offer deselect", async () => {
    const { ConversationSharePreflightStatus } =
      await import("@/conversation-share-interaction/ConversationSharePreflightStatus.js");
    const common = {
      onDeselectTurn: vi.fn(),
      onRetryPreflight: vi.fn(),
    };
    const readyPreflight = {
      status: "ready" as const,
      revision: 7,
      logEpoch: "epoch-1",
      capabilitiesFingerprint: "fingerprint",
      skippableWarnings: [],
      deferredIssues: [],
      supportedArtifactTypes: [],
      turnResults: [],
    };
    const { rerender } = render(
      createElement(ConversationSharePreflightStatus, {
        ...common,
        preflight: {
          ...readyPreflight,
          blockingIssues: [{ code: "unknown" as const, scope: "transport" as const }],
        },
      }),
    );
    fireEvent.click(screen.getByTestId("conversation-share-selection-preflight-status"));
    expect(
      await screen.findByTestId("conversation-share-selection-preflight-popover"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("conversation-share-preflight-retry"));
    expect(common.onRetryPreflight).toHaveBeenCalledTimes(1);

    rerender(
      createElement(ConversationSharePreflightStatus, {
        ...common,
        preflight: {
          ...readyPreflight,
          blockingIssues: [
            {
              code: "running_turn" as const,
              scope: "turn" as const,
              turnOrdinal: 2,
            },
          ],
        },
      }),
    );
    expect(screen.queryByTestId("conversation-share-preflight-retry")).toBeNull();
  });
});

describe("conversation share selection mode motion", () => {
  it("panel keeps a 200ms motion and switches instantly under reduced motion", async () => {
    const { resolveConversationShareSelectionPanelMotion } =
      await import("@/v4/conversationShareModeMotion.js");
    expect(resolveConversationShareSelectionPanelMotion(false)).toEqual({
      initial: { opacity: 0, transform: "translate3d(-8px, -50%, 0)" },
      animate: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      exit: { opacity: 0, transform: "translate3d(-8px, -50%, 0)" },
      transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
    });
    expect(resolveConversationShareSelectionPanelMotion(true)).toEqual({
      initial: false,
      animate: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      exit: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      transition: { duration: 0 },
    });
  });
});

describe("conversation share selection interaction policy", () => {
  it("disables global message selection while partial selection is active and restores it after exit", async () => {
    const { resolveConversationSelectionTooltipEnabled } =
      await import("@/v4/conversationShareModePolicy.js");

    expect(
      resolveConversationSelectionTooltipEnabled({
        selectionActionsEnabled: true,
        partialShareActive: false,
      }),
    ).toBe(true);
    expect(
      resolveConversationSelectionTooltipEnabled({
        selectionActionsEnabled: true,
        partialShareActive: true,
      }),
    ).toBe(false);
    expect(
      resolveConversationSelectionTooltipEnabled({
        selectionActionsEnabled: false,
        partialShareActive: false,
      }),
    ).toBe(false);
  });
});

describe("ConversationBottomDockTransition", () => {
  it("returns animated and reduced-motion configurations for the bottom dock", async () => {
    const { resolveConversationBottomDockMotion } =
      await import("@/v4/ConversationBottomDockTransition.js");

    expect(resolveConversationBottomDockMotion(false)).toEqual({
      initial: { opacity: 0, transform: "translate3d(0, 32px, 0) scale(0.96)" },
      animate: {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        transition: { duration: 0.26, ease: [0.23, 1, 0.32, 1] },
      },
      exit: {
        opacity: 0,
        transform: "translate3d(0, 32px, 0) scale(0.97)",
        transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] },
      },
    });
    expect(resolveConversationBottomDockMotion(true)).toEqual({
      initial: false,
      animate: {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        transition: { duration: 0 },
      },
      exit: {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        transition: { duration: 0 },
      },
    });
  });
});

it.each(["idle", "stale", "checking"] as const)(
  "cannot confirm when there is a selection but preflight is %s",
  async (status) => {
    const { ConversationShareSelectionPanel } =
      await import("@/v4/ConversationShareSelectionPanel.js");
    const confirm = vi.fn();
    render(
      createElement(ConversationShareSelectionPanel, {
        visible: true,
        items: [
          {
            key: "1",
            rowId: 1,
            unitIndex: 0,
            userPreview: "hello",
            assistantPreview: "world",
            isRunning: false,
          },
        ],
        selectedRowIds: new Set([1]),
        preflight: { status },
        onToggle: vi.fn(),
        onInspect: vi.fn(),
        onCancel: vi.fn(),
        onConfirm: confirm,
      }),
    );
    const apply = screen.getByTestId("conversation-share-selection-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(confirm).not.toHaveBeenCalled();
  },
);
