// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";

const probe = vi.hoisted(() => ({
  searchWorkspaceTabs: [] as Array<{ workspacePath: string; workspaceIdentity?: string }>,
  items: [] as Array<ZCodeTaskMeta & { searchSnippets?: string[] }>,
  tree: null as ProjectTree | null,
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: (params: {
    searchQuery: string;
    workspaceTabs: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }) => {
    // Only the search call carries a query; the recents and protection calls are not under test.
    if (params.searchQuery) {
      probe.searchWorkspaceTabs = params.workspaceTabs.map((tab) => ({ ...tab }));
      return { items: probe.items, loading: false };
    }
    return { items: [], loading: false };
  },
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => (probe.tree ? { tree: probe.tree } : null),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ fileService: {} }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: undefined }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

const CLOSED_ROOT = "/work/closed-project";

function closedProject(): VirtualProject {
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

function closedTask(): ZCodeTaskMeta & { searchSnippets?: string[] } {
  return {
    taskId: "closed-task",
    traceId: "trace-closed-task",
    title: "Needle in a closed project",
    workspacePath: CLOSED_ROOT,
    createdAt: 1,
    updatedAt: 2,
    mode: "build",
    status: "completed",
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  probe.searchWorkspaceTabs = [];
  probe.items = [closedTask()];
  const listed: ProjectTask = {
    ...closedTask(),
    projectId: "closed",
    hostId: "local",
    pinned: false,
    archived: false,
  };
  probe.tree = { projects: [closedProject()], tasks: [listed] };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function searchFor(query: string) {
  render(
    createElement(CommandCenterDialog, {
      open: true,
      commands: [],
      workspaceAbsPath: "/work/open-project",
      workspaceTabs: [{ workspacePath: "/work/open-project", label: "Open project" }] as never,
      onOpenChange: vi.fn(),
      onSelectTask: vi.fn(),
      onSearchResultHighlightRequest: vi.fn(),
      onOpenCodeViewer: vi.fn(),
    }),
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: query } });
}

describe("Command Center search scope and project labels", () => {
  it("searches the local project of the sidebar even though its tab is not open", () => {
    searchFor("needle");

    expect(probe.searchWorkspaceTabs.map((tab) => tab.workspacePath)).toContain(CLOSED_ROOT);
  });

  it("shows the project name on a result instead of the workspace path", () => {
    searchFor("needle");

    expect(screen.getAllByText("Closed project").length).toBeGreaterThan(0);
    expect(screen.queryByText(CLOSED_ROOT)).toBeNull();
  });
});
