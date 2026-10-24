// @vitest-environment jsdom
// Child-conversation list shared by every sidebar view (spec: sidebar-child-conversation-counts.md
// §4, §7): child selection carries the capability (subagent → read-only, side chat → writable),
// the overflow row opens the parent, and expansion persists through the single localStorage owner.
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

import {
  TaskChildSessionRows,
  useChildSessionsExpansion,
} from "@/components/TaskChildSessionRows.js";
import { isChildSessionsExpanded } from "@/lib/childSessionExpansionPreference.js";

function parentTask(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "parent",
    traceId: "trace" as ZCodeTaskMeta["traceId"],
    title: "parent",
    workspacePath: "/ws",
    createdAt: 1,
    updatedAt: 2,
    subagentCount: 3,
    sideChatCount: 1,
    childSessions: [
      {
        sessionId: "sub-1",
        title: "sub",
        taskType: "subagent_child",
        lastActivityAt: 1,
        running: true,
      },
      {
        sessionId: "side-1",
        title: "side",
        taskType: "selection_side_chat",
        lastActivityAt: 1,
        running: false,
      },
    ],
    ...overrides,
  } as ZCodeTaskMeta;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("TaskChildSessionRows", () => {
  it("opens a subagent read-only, a side chat writable, and the overflow row opens the parent", () => {
    const onSelectSession = vi.fn();
    const onRowClick = vi.fn();
    render(
      createElement(
        "div",
        { onClick: onRowClick },
        createElement(TaskChildSessionRows, { task: parentTask(), onSelectSession }),
      ),
    );
    fireEvent.click(screen.getByLabelText("taskList.childSubagentRowLabel:sub"));
    expect(onSelectSession).toHaveBeenLastCalledWith("sub-1", {
      readOnly: true,
      selectionSideChat: false,
    });
    fireEvent.click(screen.getByLabelText("taskList.childSideChatRowLabel:side"));
    expect(onSelectSession).toHaveBeenLastCalledWith("side-1", {
      readOnly: false,
      selectionSideChat: true,
    });
    // 1 side chat + 3 subagents listed as 2 rows → 2 more; it opens the parent conversation.
    fireEvent.click(screen.getByText("taskList.childMoreLabel"));
    expect(onSelectSession).toHaveBeenLastCalledWith("parent", {
      readOnly: false,
      selectionSideChat: false,
    });
    // Child clicks never select the parent row underneath.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("renders nothing without listed children", () => {
    const { container } = render(
      createElement(TaskChildSessionRows, {
        task: parentTask({ childSessions: [] }),
        onSelectSession: vi.fn(),
      }),
    );
    expect(container.innerHTML).toBe("");
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
