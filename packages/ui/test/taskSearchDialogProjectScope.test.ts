// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";
import { TaskSearchDialog } from "@/TaskSearchDialog.js";

const probe = vi.hoisted(() => ({
  lastWorkspaceTabs: [] as Array<{ workspacePath: string; workspaceIdentity?: string }>,
  items: [] as unknown[],
  tree: null as ProjectTree | null,
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: (params: {
    workspaceTabs: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }) => {
    probe.lastWorkspaceTabs = params.workspaceTabs.map((tab) => ({ ...tab }));
    return {
      items: probe.items,
      total: probe.items.length,
      hasMore: false,
      loading: false,
      hasCurrentResult: true,
      syncingRemoteWorkspaces: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => (probe.tree ? { tree: probe.tree } : null),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

const CLOSED_ROOT = "/work/closed-project";

function project(): VirtualProject {
  return {
    id: "closed",
    hostId: "local",
    name: "Closed project",
    nameOverridden: false,
    roots: [{ rootPath: CLOSED_ROOT, position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function listedTask(): ProjectTask {
  return {
    taskId: "closed-task",
    traceId: "trace-closed-task",
    title: "Needle in a closed project",
    workspacePath: CLOSED_ROOT,
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    projectId: "closed",
    hostId: "local",
    pinned: false,
    archived: false,
  };
}

function renderOpenDialog(openTabs: Array<{ workspacePath: string }>) {
  render(
    createElement(TaskSearchDialog, {
      workspaceTabs: openTabs as never,
      onSelectTask: vi.fn(),
      openRequestId: 1,
    }),
  );
  return screen.getByPlaceholderText("taskSearch.placeholder") as HTMLInputElement;
}

describe("TaskSearchDialog project scope and labels", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probe.lastWorkspaceTabs = [];
    probe.items = [listedTask()];
    probe.tree = { projects: [project()], tasks: [listedTask()] };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("searches the local project roots of the sidebar, not only the open tabs", () => {
    const input = renderOpenDialog([{ workspacePath: "/work/open-project" }]);

    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(probe.lastWorkspaceTabs.map((tab) => tab.workspacePath)).toContain(CLOSED_ROOT);
  });

  it("shows the project name on a result instead of the workspace path", () => {
    const input = renderOpenDialog([{ workspacePath: "/work/open-project" }]);

    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.getByText("Closed project")).toBeTruthy();
    expect(screen.queryByText(CLOSED_ROOT)).toBeNull();
  });

  it("falls back to the workspace path when the project tree is not loaded", () => {
    probe.tree = null;
    const input = renderOpenDialog([{ workspacePath: "/work/open-project" }]);

    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(probe.lastWorkspaceTabs.map((tab) => tab.workspacePath)).not.toContain(CLOSED_ROOT);
    expect(screen.getByText(CLOSED_ROOT)).toBeTruthy();
  });
});
