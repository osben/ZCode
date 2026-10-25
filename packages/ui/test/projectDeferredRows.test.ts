// @vitest-environment jsdom
// Guards specs/project-sidebar-deferred-rows.md (ISSUE-064): expanded projects outside the
// sidebar viewport must not mount their task rows until they are reachable.
import { createElement, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ taskId: string; projectId: string }>,
  state: { workspaces: {} as Record<string, { activeTaskId?: string }>, startDraft: () => {} },
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ windowControllerService: {}, zcodeTaskService: {} }),
}));
vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: () => null,
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: (state: any) => unknown) =>
    select({ ...mocks.state, removeTaskState: () => {} }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: any) => unknown) => select({ openSettingsTab: () => {} }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/TaskListItem.js", async () => {
  const { createElement: h } = await import("react");
  return {
    MemoTaskItem: (props: { task: ProjectTask }) => {
      mocks.rows.push({ taskId: props.task.taskId, projectId: String(props.task.projectId) });
      return h("li", { "data-testid": `row-${props.task.taskId}` }, props.task.title);
    },
    TaskListItemContextMenuContent: () => null,
  };
});
vi.mock("@/NewTaskButtonGroup.js", () => ({ NewTaskButtonGroup: () => null }));
vi.mock("@/TaskRenameDialog.js", () => ({ TaskRenameDialog: () => null }));

/** Each project section sits PROJECT_HEIGHT px below the previous one; the root shows ROOT_HEIGHT px. */
const PROJECT_HEIGHT = 220;
const ROOT_HEIGHT = 200;
const PROJECTS = 15;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
}

function intersect(projectId: string, isIntersecting = true) {
  for (const observer of FakeIntersectionObserver.instances) {
    for (const target of observer.targets) {
      if (target.closest("section")?.getAttribute("data-project-id") !== projectId) continue;
      act(() =>
        observer.callback(
          [{ target, isIntersecting } as unknown as IntersectionObserverEntry],
          observer as unknown as IntersectionObserver,
        ),
      );
    }
  }
}

const originalRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if ((this as HTMLElement).dataset?.testRoot) return rect(0, ROOT_HEIGHT);
    const index = Number(this.closest("section")?.getAttribute("data-project-id")?.slice(1) ?? 0);
    const top = index * PROJECT_HEIGHT + 32;
    return rect(top, top + 160);
  };
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
  FakeIntersectionObserver.instances = [];
  mocks.rows.length = 0;
  mocks.state.workspaces = {};
});

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 200,
    width: 200,
    height: bottom - top,
    x: 0,
    y: top,
  } as DOMRect;
}

const task = (projectId: string, index: number, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: `${projectId}-t${index}`,
  title: `${projectId}-t${index}`,
  traceId: `${projectId}-t${index}`,
  workspacePath: `/${projectId}`,
  hostId: "local",
  projectId,
  pinned: false,
  archived: false,
  createdAt: index,
  updatedAt: index,
  mode: "default",
  ...extra,
});

function nodeProps(index: number, expanded: boolean, extra: Record<string, unknown> = {}) {
  const id = `p${index}`;
  return {
    project: {
      id,
      hostId: "local",
      name: id,
      roots: [{ rootPath: `/${id}`, position: 0, isPrimary: true }],
      deleted: false,
      pinned: false,
      nameOverridden: false,
      position: index,
      createdAt: 1,
      updatedAt: 1,
    },
    expanded,
    onExpandedChange: () => {},
    tasks: Array.from({ length: 8 }, (_, t) => task(id, t)),
    onCreate: () => {},
    onViewFiles: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onPin: () => {},
    onMove: () => {},
    onSelect: () => {},
    refresh: async () => {},
    ...extra,
  };
}

function Sidebar({
  expanded = () => true,
  extra = () => ({}),
  withViewport = true,
  activeWorkspaceKey,
  mobileActiveTaskKey,
}: {
  expanded?: (index: number) => boolean;
  extra?: (index: number) => Record<string, unknown>;
  withViewport?: boolean;
  activeWorkspaceKey?: string;
  mobileActiveTaskKey?: string;
}): ReactNode {
  return createElement(
    TooltipProvider,
    null,
    createElement(
      ProjectTaskListContext.Provider,
      {
        value: { activeWorkspaceKey, mobileActiveTaskKey },
      },
      createElement(
        "div",
        {
          "data-test-root": "true",
          ...(withViewport ? { "data-project-rows-viewport": "" } : {}),
        },
        ...Array.from({ length: PROJECTS }, (_, index) =>
          createElement(ProjectNode, {
            key: index,
            ...nodeProps(index, expanded(index), extra(index)),
          } as any),
        ),
      ),
    ),
  );
}

const mountedProjects = () => [...new Set(mocks.rows.map((row) => row.projectId))].sort();
const placeholders = () => document.querySelectorAll("[data-project-rows-placeholder]");

it("mounts rows only for expanded projects within half a viewport of the scroll area", () => {
  render(createElement(Sidebar));
  // Root shows 0–200 px; reach extends half a viewport (100 px) below, so slots at 32 and 252 qualify.
  expect(mountedProjects()).toEqual(["p0", "p1"]);
  expect(mocks.rows).toHaveLength(10);
  expect(placeholders()).toHaveLength(PROJECTS - 2);
  // Off-screen slots are inert placeholders sized from the first page plus "show more".
  const placeholder = placeholders()[0] as HTMLElement;
  expect(placeholder.getAttribute("aria-hidden")).toBe("true");
  expect(placeholder.style.height).toBe(`${5 * 32 + 20}px`);
  expect(placeholder.querySelector("[data-testid]")).toBeNull();
  // Observers watch the sidebar scroller with a half-viewport margin.
  const observer = FakeIntersectionObserver.instances.at(-1)!;
  expect((observer.options!.root as HTMLElement).dataset.testRoot).toBe("true");
  expect(observer.options?.rootMargin).toBe("50% 0px");
});

it("mounts a project's rows in comparator order when it scrolls into reach, and keeps them", () => {
  render(createElement(Sidebar));
  mocks.rows.length = 0;
  intersect("p9");
  expect(mocks.rows.map((row) => row.taskId)).toEqual([
    "p9-t7",
    "p9-t6",
    "p9-t5",
    "p9-t4",
    "p9-t3",
  ]);
  expect(
    document.querySelector('section[data-project-id="p9"] [data-task-list-show-more="true"]'),
  ).not.toBeNull();
  // Scrolling away again never unmounts mounted rows.
  intersect("p9", false);
  expect(document.querySelector('[data-testid="row-p9-t7"]')).not.toBeNull();
  expect(placeholders()).toHaveLength(PROJECTS - 3);
});

it("keeps rows mounted across collapse and re-expand", () => {
  const { rerender } = render(createElement(Sidebar));
  intersect("p9");
  rerender(createElement(Sidebar, { expanded: (index) => index !== 9 }));
  expect(document.querySelector('[data-testid="row-p9-t7"]')).toBeNull();
  rerender(createElement(Sidebar));
  expect(document.querySelector('[data-testid="row-p9-t7"]')).not.toBeNull();
  expect(
    document.querySelector('section[data-project-id="p9"] [data-project-rows-placeholder]'),
  ).toBeNull();
});

it("mounts rows immediately when the user expands a project that started collapsed", () => {
  const { rerender } = render(createElement(Sidebar, { expanded: (index) => index !== 12 }));
  expect(mountedProjects()).not.toContain("p12");
  rerender(createElement(Sidebar));
  expect(mountedProjects()).toContain("p12");
  expect(
    document.querySelector('section[data-project-id="p12"] [data-project-rows-placeholder]'),
  ).toBeNull();
});

it("mounts rows when keyboard focus enters a deferred project's header", () => {
  render(createElement(Sidebar));
  expect(mountedProjects()).not.toContain("p11");
  const header = document.querySelector<HTMLElement>(
    'section[data-project-id="p11"] [data-testid="virtual-project-row"]',
  )!;
  act(() => header.focus());
  expect(mountedProjects()).toContain("p11");
  // Tab order after the header now reaches the project's own rows, not the next project.
  const section = document.querySelector('section[data-project-id="p11"]')!;
  expect(section.querySelector('[data-testid="row-p11-t7"]')).not.toBeNull();
});

it("mounts rows of a deferred project that contains the active task", () => {
  mocks.state.workspaces = { "/p13": { activeTaskId: "p13-t6" } };
  render(createElement(Sidebar, { activeWorkspaceKey: "/p13" }));
  expect(mountedProjects()).toEqual(["p0", "p1", "p13"]);
  expect(document.querySelector('[data-testid="row-p13-t6"]')).not.toBeNull();
});

it("mounts rows of a deferred project that holds the mobile remote active task", () => {
  render(createElement(Sidebar, { mobileActiveTaskKey: "/p14:p14-t5" }));
  expect(mountedProjects()).toContain("p14");
});

it("shows the unread dot on a collapsed project without mounting its rows", () => {
  render(
    createElement(Sidebar, {
      expanded: (index) => index !== 10,
      extra: (index) => (index === 10 ? { hasUnread: true } : {}),
    }),
  );
  const section = document.querySelector('section[data-project-id="p10"]')!;
  expect(section.querySelector('[data-testid="virtual-project-unread"]')).not.toBeNull();
  expect(mountedProjects()).not.toContain("p10");
});

it("does not defer when the sidebar provides no scroll viewport", () => {
  render(createElement(Sidebar, { withViewport: false }));
  expect(mountedProjects()).toHaveLength(PROJECTS);
  expect(placeholders()).toHaveLength(0);
});

it("does not defer when IntersectionObserver is unavailable", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  render(createElement(Sidebar));
  expect(mountedProjects()).toHaveLength(PROJECTS);
});

it("renders the empty state directly for an expanded project without tasks", () => {
  render(createElement(Sidebar, { extra: (index) => (index === 8 ? { tasks: [] } : {}) }));
  const section = document.querySelector('section[data-project-id="p8"]')!;
  expect(section.querySelector('[data-testid="project-no-tasks"]')).not.toBeNull();
  expect(section.querySelector("[data-project-rows-placeholder]")).toBeNull();
});

it("disconnects observers when rows are revealed or the node unmounts", () => {
  const { unmount } = render(createElement(Sidebar));
  intersect("p9");
  const p9Observers = FakeIntersectionObserver.instances.filter((observer) =>
    [...observer.targets].some(
      (target) => target.closest("section")?.getAttribute("data-project-id") === "p9",
    ),
  );
  expect(p9Observers).toHaveLength(0);
  unmount();
  expect(FakeIntersectionObserver.instances.every((observer) => observer.targets.size === 0)).toBe(
    true,
  );
});
