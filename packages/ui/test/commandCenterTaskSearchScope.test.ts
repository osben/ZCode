// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";

const probe = vi.hoisted(() => ({
  // Every useGlobalTaskList call in order: the query it received and how many workspaces it was scoped to.
  calls: [] as Array<{ searchQuery: string; scopeCount: number }>,
  searchWorkspaceTabs: [] as Array<{ workspacePath: string; workspaceIdentity?: string }>,
  items: [] as Array<ZCodeTaskMeta & { searchSnippets?: string[] }>,
  tree: null as ProjectTree | null,
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: (params: {
    searchQuery: string;
    workspaceTabs: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }) => {
    probe.calls.push({ searchQuery: params.searchQuery, scopeCount: params.workspaceTabs.length });
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
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  probe.calls = [];
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Renders the open command center and returns its input; calls made by the first render are discarded. */
function openDialog(): HTMLInputElement {
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
  probe.calls = [];
  return screen.getByRole("combobox") as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/** Non-empty queries the task-list hook received, with consecutive duplicates collapsed. */
function settledQueryRuns(): string[] {
  const runs: string[] = [];
  for (const call of probe.calls) {
    if (!call.searchQuery) continue;
    if (runs.at(-1) !== call.searchQuery) runs.push(call.searchQuery);
  }
  return runs;
}

describe("Command Center search scope and project labels", () => {
  it("searches the local project of the sidebar even though its tab is not open", () => {
    const input = openDialog();
    type(input, "needle");
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(probe.searchWorkspaceTabs.map((tab) => tab.workspacePath)).toContain(CLOSED_ROOT);
  });

  it("shows the project name on a result instead of the workspace path", () => {
    const input = openDialog();
    type(input, "needle");
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.getAllByText("Closed project").length).toBeGreaterThan(0);
    expect(screen.queryByText(CLOSED_ROOT)).toBeNull();
  });
});

describe("Command Center task search settle", () => {
  it("queries no workspace and sends no query before 200 ms, then one query after", () => {
    const input = openDialog();
    type(input, "needle");

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(probe.calls.some((call) => call.scopeCount > 0)).toBe(false);
    expect(probe.calls.some((call) => call.searchQuery === "needle")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(settledQueryRuns()).toEqual(["needle"]);
    expect(probe.searchWorkspaceTabs.map((tab) => tab.workspacePath)).toContain(CLOSED_ROOT);
  });

  it("restarts the window when a second keystroke arrives before the first settles", () => {
    const input = openDialog();
    type(input, "needle");
    act(() => {
      vi.advanceTimersByTime(150);
    });
    type(input, "needles");
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // The first query would have settled 300 ms after it was typed; it was replaced, so nothing has been sent yet.
    expect(probe.calls.some((call) => call.scopeCount > 0 || call.searchQuery !== "")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(settledQueryRuns()).toEqual(["needles"]);
  });

  it("cancels a pending settle when the input is cleared", () => {
    const input = openDialog();
    type(input, "needle");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    type(input, "");
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Only non-empty queries are checked: the recents call legitimately scopes to the open workspace when the query is empty.
    expect(settledQueryRuns()).toEqual([]);
  });
});
