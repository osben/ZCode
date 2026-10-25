// @vitest-environment jsdom
// Side-chat list shared by every sidebar view (spec: sidebar-child-conversation-counts.md §4, §7,
// §9): side chats open writable with restricted commands, the overflow row opens the parent, each
// row owns its context menu, and expansion persists through the single localStorage owner.
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) =>
        values?.title ? `${id}:${String(values.title)}` : id,
      formatPlural: ({ id }: { id: string }) => id,
    },
  }),
}));
vi.mock("@/lib/taskListItemPresentation.js", () => ({
  formatTaskRelativeTime: () => "1m",
}));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  TaskChildSessionRows,
  useChildSessionsExpansion,
} from "@/components/TaskChildSessionRows.js";
import { isChildSessionsExpanded } from "@/lib/childSessionExpansionPreference.js";

function sideChat(sessionId: string, title: string) {
  return {
    sessionId,
    title,
    taskType: "selection_side_chat" as const,
    lastActivityAt: 1,
    running: false,
  };
}

function parentTask(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "parent",
    traceId: "trace" as ZCodeTaskMeta["traceId"],
    title: "parent",
    workspacePath: "/ws",
    createdAt: 1,
    updatedAt: 2,
    sideChatCount: 3,
    childSessions: [sideChat("side-1", "first"), sideChat("side-2", "second")],
    ...overrides,
  } as ZCodeTaskMeta;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("TaskChildSessionRows", () => {
  it("opens a side chat with its capability and the overflow row opens the parent", () => {
    const onSelectSession = vi.fn();
    const onRowClick = vi.fn();
    render(
      createElement(
        "div",
        { onClick: onRowClick },
        createElement(TaskChildSessionRows, {
          task: parentTask(),
          expanded: true,
          onSelectSession,
        }),
      ),
    );
    fireEvent.click(screen.getByLabelText("taskList.childSideChatRowLabel:first"));
    expect(onSelectSession).toHaveBeenLastCalledWith("side-1", { selectionSideChat: true });
    // 3 side chats, 2 listed (summary cap) → 1 more; it opens the parent conversation.
    fireEvent.click(screen.getByText("taskList.childMoreLabel"));
    expect(onSelectSession).toHaveBeenLastCalledWith("parent", {});
    // Child clicks never select the parent row underneath.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("renders nothing without listed children or while collapsed (§9: no running-inline rows)", () => {
    const empty = render(
      createElement(TaskChildSessionRows, {
        task: parentTask({ childSessions: [] }),
        expanded: true,
        onSelectSession: vi.fn(),
      }),
    );
    expect(empty.container.innerHTML).toBe("");
    const collapsed = render(
      createElement(TaskChildSessionRows, {
        task: parentTask(),
        expanded: false,
        onSelectSession: vi.fn(),
      }),
    );
    expect(collapsed.container.innerHTML).toBe("");
  });

  it("right-click opens the side chat's own menu, never the parent's (§9.4)", async () => {
    const onSelectSession = vi.fn();
    const onParentContextMenu = vi.fn();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      createElement(
        "div",
        { onContextMenu: onParentContextMenu },
        createElement(TaskChildSessionRows, {
          task: parentTask(),
          expanded: true,
          onSelectSession,
        }),
      ),
    );
    fireEvent.contextMenu(screen.getByLabelText("taskList.childSideChatRowLabel:second"));
    expect(onParentContextMenu).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText("appHeader.copySessionId"));
    expect(writeText).toHaveBeenCalledWith("side-2");

    fireEvent.contextMenu(screen.getByLabelText("taskList.childSideChatRowLabel:second"));
    fireEvent.click(await screen.findByText("common.open"));
    expect(onSelectSession).toHaveBeenLastCalledWith("side-2", { selectionSideChat: true });
  });
});

describe("useChildSessionsExpansion", () => {
  it("defaults collapsed, toggles, and persists per parent so other views read the same state", () => {
    const { result } = renderHook(() => useChildSessionsExpansion("parent"));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(isChildSessionsExpanded("parent")).toBe(true);
    expect(isChildSessionsExpanded("other")).toBe(false);
    const remounted = renderHook(() => useChildSessionsExpansion("parent"));
    expect(remounted.result.current[0]).toBe(true);
    act(() => remounted.result.current[1]());
    expect(isChildSessionsExpanded("parent")).toBe(false);
  });
});
