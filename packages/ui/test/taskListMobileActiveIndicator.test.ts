import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { MemoTaskItem as TaskItem } from "@/TaskListItem.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const { workspaceStateByPath } = vi.hoisted(() => ({
  workspaceStateByPath: new Map<string, unknown>(),
}));

vi.mock("@/store/zcodeSessionStore.js", async () => {
  const actual = await vi.importActual<typeof import("@/store/zcodeSessionStore.js")>(
    "@/store/zcodeSessionStore.js",
  );
  return {
    ...actual,
    useZCodeSessionStore: (selector: (state: { workspaces: Record<string, unknown> }) => unknown) =>
      selector({ workspaces: Object.fromEntries(workspaceStateByPath) }),
  };
});

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
    taskProvider: "codex",
    taskSessionFile: { loading: false, path: null, exists: false },
    taskNativeSessionLogFile: { loading: false, path: null, exists: false },
    providerConfigFile: { loading: false, path: null, exists: false },
    fileManagerLabel: "Open in Finder",
    handleCopyText: async () => {},
    handleOpenTaskPathInFileManager: async () => {},
    handleOpenProviderConfig: async () => {},
  }),
}));

beforeEach(() => {
  workspaceStateByPath.clear();
});

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "mobile-active-task",
    traceId: "trace-mobile-active-task",
    title: "手机正在查看的任务",
    workspacePath: "/tmp/workspace-mobile-active",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

function createIntl() {
  return {
    formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) => {
      try {
        return expectedCopy(id, values);
      } catch {
        return id;
      }
    },
  };
}

function renderWithTooltipProvider(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}

function renderTaskItem({
  task = createTaskMeta(),
  isPinned = false,
  isMobileActive = true,
  legacyUnread = Boolean(task.unreadAt),
}: {
  task?: ZCodeTaskMeta;
  isPinned?: boolean;
  isMobileActive?: boolean;
  legacyUnread?: boolean;
} = {}) {
  workspaceStateByPath.set(task.workspacePath, {
    taskRuntimeByTaskId: {
      [task.taskId]: {
        status: "completed",
        error: null,
        usage: null,
      },
    },
    taskUiByTaskId: {
      [task.taskId]: {
        permissionRequest: null,
        pendingPermissionRequests: [],
      },
    },
    taskUnreadByTaskId: legacyUnread ? { [task.taskId]: true } : {},
  });

  return renderWithTooltipProvider(
    createElement(TaskItem, {
      workspacePath: task.workspacePath,
      task,
      isPinned,
      isActive: false,
      isMobileActive,
      onSelectTask: () => {},
      onArchiveTaskInline: () => {},
      onCancelArchiveConfirm: () => {},
      isArchiveConfirming: false,
      intl: createIntl(),
    }),
  );
}

describe("TaskList mobile active indicator", () => {
  it("shows a phone marker on the desktop task row that is open on mobile", () => {
    const html = renderTaskItem();

    expect(html).toContain('data-mobile-active-task="true"');
    expect(html).toContain(expectedCopy("taskList.mobileActive"));
  });

  it("renders unread dot with sky colors", () => {
    const html = renderTaskItem({
      task: createTaskMeta({ unreadAt: 100 }),
      isMobileActive: false,
      legacyUnread: false,
    });

    expect(html).toContain('data-unread-indicator="true"');
    expect(html).toContain("bg-icon-blue");
    expect(html).not.toContain("bg-brand");
  });

  it("renders error dot from task meta status", () => {
    const html = renderTaskItem({
      task: createTaskMeta({ status: "error", unreadAt: 100 }),
      isMobileActive: false,
      legacyUnread: false,
    });

    expect(html).toContain('data-error-indicator="true"');
    expect(html).toContain("bg-destructive");
    expect(html).not.toContain('data-unread-indicator="true"');
  });

  it("places the phone marker before the task title text", () => {
    const html = renderTaskItem();

    expect(html.indexOf(`aria-label="${expectedCopy("taskList.mobileActive")}"`)).toBeLessThan(
      html.indexOf('data-task-title-copy="original"'),
    );
    expect(html).not.toContain('title="手机正在查看的任务"');
  });

  it("keeps the phone marker out of the title flex flow", () => {
    const html = renderTaskItem();

    expect(html).toMatch(
      new RegExp(
        `<span data-mobile-active-task="true" class="[^"]*absolute[^"]*" aria-label="${expectedCopy("taskList.mobileActive")}" data-state="closed" data-slot="tooltip-trigger">`,
      ),
    );
  });

  it("keeps the phone marker mounted until React interaction state replaces it", () => {
    const html = renderTaskItem();

    expect(html).toMatch(
      new RegExp(
        `<span data-mobile-active-task="true"[^>]*aria-label="${expectedCopy("taskList.mobileActive")}"[^>]*data-slot="tooltip-trigger">`,
      ),
    );
    expect(html).not.toContain("group-hover/task-item:hidden");
    expect(html).not.toContain('aria-label="taskList.pin"');
  });

  it("does not mount unpin until interaction when the phone marker owns the leading slot", () => {
    const html = renderTaskItem({ isPinned: true });

    expect(html).toMatch(
      new RegExp(
        `<span data-mobile-active-task="true"[^>]*aria-label="${expectedCopy("taskList.mobileActive")}"[^>]*data-slot="tooltip-trigger">`,
      ),
    );
    expect(html).not.toContain('aria-label="taskList.unpin"');
  });
});
