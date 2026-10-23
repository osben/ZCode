// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { MemoTaskItem } from "@/TaskListItem.js";
import { SidebarTooltipProvider } from "@/ControlHintTooltip.js";

// Row-render probe: TaskTitleOverflowText sits inside the memoized row body, so its render count
// tracks row re-renders. The hover card lives in a non-memoized frame, so opening and closing it
// must leave this count untouched.
const { titleTextTitles } = vi.hoisted(() => ({
  titleTextTitles: [] as string[],
}));

vi.mock("@/components/TaskTitleOverflowText.js", () => ({
  TaskTitleOverflowText: ({ children, title }: { children?: ReactNode; title?: string }) => {
    titleTextTitles.push(title ?? "");
    return createElement("span", null, children);
  },
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => null,
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (selector: (state: { openSubmit: () => void }) => unknown) =>
    selector({ openSubmit: vi.fn() }),
}));

vi.mock("@/store/modelTrajectoryStore.js", () => ({
  useModelTrajectoryStore: {
    getState: () => ({
      requestOpen: vi.fn(),
    }),
  },
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: () => {},
}));

vi.mock("@/store/zcodeSessionStore.js", async () => {
  const actual = await vi.importActual<typeof import("@/store/zcodeSessionStore.js")>(
    "@/store/zcodeSessionStore.js",
  );
  return {
    ...actual,
    getTaskRuntimeState: () => "idle",
    getTaskUnreadIndicator: () => false,
    hasTaskPendingHumanInterventionRequest: () => false,
    hasTaskPendingPermissionRequest: () => false,
    selectWorkspaceZCodeState: () => ({}),
    useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
  };
});

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
    taskSessionFile: { loading: false, path: null, exists: false },
    taskNativeSessionLogFile: { loading: false, path: null, exists: false },
    providerConfigFile: { loading: false, path: null, exists: false },
    fileManagerLabel: "Finder",
    handleCopyText: vi.fn(),
    handleOpenProviderConfig: vi.fn(),
    handleOpenTaskPathInFileManager: vi.fn(),
  }),
}));

vi.mock("@/TaskListItemContextMenu.js", () => ({
  TaskListItemContextMenu: () => createElement("div", { "data-testid": "task-context-menu" }),
}));

// Radix Tooltip reports a controlled/uncontrolled switch through console.warn; the flat row must
// keep handing Radix a boolean open prop no matter how hover state changes (ISSUE-027).
const MODE_SWITCH_WARNING =
  /is changing from (controlled|uncontrolled) to (controlled|uncontrolled)/;

const stableIntl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
    id === "taskList.attentionCount"
      ? `${String(values?.label ?? "")} ×${String(values?.count ?? "")}`
      : id,
};

function createTask(): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "codex",
    taskId: "task-1",
    title: "Flat hover card",
    traceId: "trace-1",
    updatedAt: 2,
    workspacePath: "/workspace",
  };
}

function renderRow(overrides: { hoverEnabled?: boolean } = {}) {
  return render(
    createElement(
      // The app renders sidebar rows under this provider (300 ms delay, hoverable content off),
      // which is what makes pointer leave close the card immediately.
      SidebarTooltipProvider,
      null,
      createElement(MemoTaskItem, {
        hoverEnabled: overrides.hoverEnabled ?? true,
        intl: stableIntl,
        isActive: false,
        isArchiveConfirming: false,
        isPinned: false,
        onArchiveTask: vi.fn(),
        onArchiveTaskInline: vi.fn(),
        onCancelArchiveConfirm: vi.fn(),
        onMarkTaskAsUnread: vi.fn(),
        onSelectTask: vi.fn(),
        onStartRenameTask: vi.fn(),
        onTogglePinTask: vi.fn(),
        task: createTask(),
        workspacePath: "/workspace",
      }),
    ),
  );
}

function hoverCard(): Element | null {
  return document.querySelector("[data-task-hover-card]");
}

async function openHoverCard(row: Element) {
  fireEvent.pointerMove(row, { pointerType: "mouse" });
  await waitFor(() => expect(hoverCard()).not.toBeNull());
}

async function closeHoverCard(row: Element) {
  fireEvent.pointerLeave(row, { pointerType: "mouse" });
  await waitFor(() => expect(hoverCard()).toBeNull());
}

describe("TaskListItem flat-row hover card", () => {
  beforeEach(() => {
    // Radix Popper measures the trigger with ResizeObserver; jsdom does not provide one.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    titleTextTitles.length = 0;
  });

  it("shows the hover card with status and content on hover", async () => {
    const { container } = renderRow();
    const row = container.querySelector<HTMLElement>("[data-task-item-key]")!;
    expect(row).not.toBeNull();

    await openHoverCard(row);

    const card = hoverCard()!;
    expect(card.getAttribute("data-task-hover-status")).toBe("ready");
    expect(card.textContent).toContain("Flat hover card");

    await closeHoverCard(row);
  });

  it("does not re-render the memoized row body while the hover card opens and closes", async () => {
    const { container } = renderRow();
    const row = container.querySelector<HTMLElement>("[data-task-item-key]")!;
    const rendersAtRest = titleTextTitles.length;
    expect(rendersAtRest).toBeGreaterThan(0);

    await openHoverCard(row);
    expect(titleTextTitles.length).toBe(rendersAtRest);

    await closeHoverCard(row);
    expect(titleTextTitles.length).toBe(rendersAtRest);
  });

  it("logs no controlled/uncontrolled warning across hover and hoverEnabled flips", async () => {
    const spies = [
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const { container, rerender } = renderRow();
    const row = container.querySelector<HTMLElement>("[data-task-item-key]")!;

    await openHoverCard(row);

    // hoverEnabled flips on a mounted row (web remote-control presentation): open must stay boolean.
    const renderWithHoverOff = () =>
      rerender(
        createElement(
          SidebarTooltipProvider,
          null,
          createElement(MemoTaskItem, {
            hoverEnabled: false,
            intl: stableIntl,
            isActive: false,
            isArchiveConfirming: false,
            isPinned: false,
            onArchiveTask: vi.fn(),
            onArchiveTaskInline: vi.fn(),
            onCancelArchiveConfirm: vi.fn(),
            onMarkTaskAsUnread: vi.fn(),
            onSelectTask: vi.fn(),
            onStartRenameTask: vi.fn(),
            onTogglePinTask: vi.fn(),
            task: createTask(),
            workspacePath: "/workspace",
          }),
        ),
      );
    const renderWithHoverOn = () =>
      rerender(
        createElement(
          SidebarTooltipProvider,
          null,
          createElement(MemoTaskItem, {
            hoverEnabled: true,
            intl: stableIntl,
            isActive: false,
            isArchiveConfirming: false,
            isPinned: false,
            onArchiveTask: vi.fn(),
            onArchiveTaskInline: vi.fn(),
            onCancelArchiveConfirm: vi.fn(),
            onMarkTaskAsUnread: vi.fn(),
            onSelectTask: vi.fn(),
            onStartRenameTask: vi.fn(),
            onTogglePinTask: vi.fn(),
            task: createTask(),
            workspacePath: "/workspace",
          }),
        ),
      );

    renderWithHoverOff();
    await waitFor(() => expect(hoverCard()).toBeNull());

    // Re-enabling hover must not pop the stale card open without a pointer over the row.
    renderWithHoverOn();
    expect(hoverCard()).toBeNull();

    const warnings = spies
      .flatMap((spy) => spy.mock.calls)
      .map((args: unknown[]) => args.map(String).join(" "))
      .filter((message) => MODE_SWITCH_WARNING.test(message));
    expect(warnings).toEqual([]);
  });
});
