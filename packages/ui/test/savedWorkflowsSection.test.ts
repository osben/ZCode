// @vitest-environment jsdom
// The saved-workflows hub "page" layer (docs/dynamic-workflow/launch.md "The hub page" +
// "Names and scopes"): a pinned "global" group on top, then groups per open project. Both groups
// are stubbed — the stubs drive props.onStateChange reports from a controllable map and expose
// buttons — so only the page layer is under test: group order, current marker, total count
// (including global), empty state (project groups only), spinner, refresh broadcast, detail
// state, and deep links.
import { createElement, useEffect, useMemo, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
  TID_WORKFLOWS_OPEN_SETTINGS,
  TID_WORKFLOWS_REFRESH,
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  TID_WORKFLOW_GLOBAL_GROUP,
  TID_WORKFLOW_PROJECT_GROUP,
  resolveWorkspaceKey,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

interface FakeTab {
  id: string;
  kind: "workspace" | "settings";
  workspacePath: string;
  label: string;
  workspacePurpose?: string;
  availability?: string;
  remoteSessionId?: string;
}

const tabStoreState: {
  tabs: FakeTab[];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  openSettingsTab: () => void;
} = {
  tabs: [],
  activeWorkspacePath: null,
  activeWorkspaceIdentity: null,
  openSettingsTab: () => {},
};
const settingsNavigation = vi.hoisted(() => ({ setPendingSettingsSectionIntent: vi.fn() }));
vi.mock("@/lib/settingsNavigation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPendingSettingsSectionIntent: settingsNavigation.setPendingSettingsSectionIntent,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof tabStoreState) => unknown) => selector(tabStoreState),
}));
// The page layer only consumes the project catalog; a dedicated hook test covers Host identity and offline filtering.
vi.mock("@/project-sidebar/useSavedWorkflowProjectOptions.js", () => ({
  useSavedWorkflowProjectOptions: () =>
    useMemo(
      () =>
        tabStoreState.tabs
          .filter(
            (tab) =>
              tab.kind === "workspace" &&
              tab.workspacePurpose !== "conversation" &&
              tab.availability !== "unavailable",
          )
          .map((tab) => ({
            projectId: tab.id,
            hostId: tab.remoteSessionId ? "remote:server:test" : "local",
            ...(tab.remoteSessionId
              ? { workspaceIdentity: `remote:server:test:${tab.workspacePath}` }
              : {}),
            workspacePath: tab.workspacePath,
            label: tab.label,
          })),
      [tabStoreState.tabs],
    ),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

// Each group's readiness is keyed (project workspacePath or "global"); tests edit this map directly.
const groupReadiness: Record<string, SavedWorkflowGroupState> = {};

vi.mock("@/settings/saved-workflows/SavedWorkflowProjectGroup.js", () => ({
  SavedWorkflowProjectGroup: ({
    project,
    isCurrent,
    refreshSeq,
    mode,
    onStateChange,
    onOpenDetail,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onBack,
  }: {
    project: AutomationWorkspaceOption;
    isCurrent: boolean;
    refreshSeq: number;
    mode: SavedWorkflowGroupMode;
    onStateChange: (workspaceKey: string, state: SavedWorkflowGroupState) => void;
    onOpenDetail: (name: string) => void;
    onNavigateToLaunchedRun?: (target: unknown, sessionId: string) => void;
    onCreateViaChat?: (prompt: string, target: unknown) => void;
    onBack: () => void;
  }) => {
    const key = resolveWorkspaceKey({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
    });
    const st = groupReadiness[project.workspacePath] ?? { loaded: false, empty: false, count: 0 };
    useEffect(() => {
      onStateChange(key, st);
    }, [key, onStateChange, refreshSeq, st.count, st.empty, st.loaded]);
    if (mode.kind === "list" && st.loaded && st.empty) return null;
    return createElement(
      "div",
      {
        "data-testid": testId(TID_WORKFLOW_PROJECT_GROUP, key),
        "data-current": isCurrent ? "true" : "false",
        "data-mode": mode.kind,
        "data-refresh": String(refreshSeq),
        "data-name": mode.kind === "detail" ? mode.name : "",
      },
      project.label,
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `open-${project.workspacePath}`,
          onClick: () => onOpenDetail("wf-1"),
        },
        "open",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `launch-${project.workspacePath}`,
          onClick: () => onNavigateToLaunchedRun?.({ workspacePath: project.workspacePath }, "s-1"),
        },
        "launch",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `create-${project.workspacePath}`,
          onClick: () => onCreateViaChat?.("create", { workspacePath: project.workspacePath }),
        },
        "create",
      ),
      createElement(
        "button",
        { type: "button", "data-testid": `back-${project.workspacePath}`, onClick: onBack },
        "back",
      ),
    );
  },
}));

// Global group stub: always rendered (even when empty); reports state under the "global" key; exposes open / moved / back.
vi.mock("@/settings/saved-workflows/SavedWorkflowGlobalGroup.js", () => ({
  SavedWorkflowGlobalGroup: ({
    refreshSeq,
    mode,
    onStateChange,
    onOpenDetail,
    onMoved,
    onBack,
    localProjects,
    activeProjectKey,
  }: {
    refreshSeq: number;
    mode: SavedWorkflowGroupMode;
    onStateChange: (key: "global", state: SavedWorkflowGroupState) => void;
    onOpenDetail: (name: string) => void;
    onMoved: () => void;
    onBack: () => void;
    localProjects: readonly AutomationWorkspaceOption[];
    activeProjectKey: string | null;
  }) => {
    const st = groupReadiness.global ?? { loaded: false, empty: false, count: 0 };
    useEffect(() => {
      onStateChange("global", st);
    }, [onStateChange, refreshSeq, st.count, st.empty, st.loaded]);
    return createElement(
      "div",
      {
        "data-testid": TID_WORKFLOW_GLOBAL_GROUP,
        "data-mode": mode.kind,
        "data-refresh": String(refreshSeq),
        "data-name": mode.kind === "detail" ? mode.name : "",
        "data-local": localProjects.map((p) => p.workspacePath).join(","),
        "data-active": activeProjectKey ?? "",
      },
      "global",
      createElement(
        "button",
        { type: "button", "data-testid": "global-open", onClick: () => onOpenDetail("g-1") },
        "open",
      ),
      createElement(
        "button",
        { type: "button", "data-testid": "global-moved", onClick: onMoved },
        "moved",
      ),
      createElement(
        "button",
        { type: "button", "data-testid": "global-back", onClick: onBack },
        "back",
      ),
    );
  },
}));

const { SavedWorkflowsSection } =
  await import("@/settings/saved-workflows/SavedWorkflowsSection.js");

function workspaceTab(path: string, label: string, overrides: Partial<FakeTab> = {}): FakeTab {
  return { id: `t-${path}`, kind: "workspace", workspacePath: path, label, ...overrides };
}

function mount(props: Partial<Parameters<typeof SavedWorkflowsSection>[0]> = {}) {
  const onNavigateToLaunchedRun = vi.fn();
  const onCreateViaChat = vi.fn();
  const onOpenWorkflowRun = vi.fn();
  const utils = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SavedWorkflowsSection, {
        workspacePath: tabStoreState.activeWorkspacePath,
        onNavigateToLaunchedRun,
        onCreateViaChat,
        onOpenWorkflowRun,
        ...props,
      }),
    ),
  );
  return { ...utils, onNavigateToLaunchedRun, onCreateViaChat, onOpenWorkflowRun };
}

function keyOf(path: string): string {
  return resolveWorkspaceKey({ workspacePath: path });
}

describe("SavedWorkflowsSection (global + multi-project page)", () => {
  beforeEach(() => {
    tabStoreState.tabs = [];
    tabStoreState.activeWorkspacePath = null;
    tabStoreState.activeWorkspaceIdentity = null;
    tabStoreState.openSettingsTab = vi.fn();
    for (const k of Object.keys(groupReadiness)) delete groupReadiness[k];
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    resetDynamicWorkflowAvailabilityStoreForTests();
  });

  it("the global group is always pinned above all project groups; total = global + each project group count", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    groupReadiness.global = { loaded: true, empty: false, count: 2 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 3 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 4 };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")));
    const groups = screen.getAllByTestId(
      (id) => id === TID_WORKFLOW_GLOBAL_GROUP || id.startsWith(TID_WORKFLOW_PROJECT_GROUP),
    );
    expect(groups[0]?.getAttribute("data-testid")).toBe(TID_WORKFLOW_GLOBAL_GROUP);
    expect(groups[1]?.getAttribute("data-testid")).toBe(
      testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")),
    );
    expect(groups[2]?.getAttribute("data-testid")).toBe(
      testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")),
    );
    expect(screen.getByText(expectedCopy("workflows.hub.sectionTitle")).textContent).toContain("9");
  });

  it("the global group receives local project candidates (remote filtered out) and the active project key", async () => {
    tabStoreState.tabs = [
      workspaceTab("/a", "Alpha"),
      workspaceTab("/remote", "Remote", { remoteSessionId: "sess-1" }),
    ];
    tabStoreState.activeWorkspacePath = "/a";
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount({ workspacePath: "/a" });
    const globalGroup = await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    expect(globalGroup.getAttribute("data-local")).toBe("/a");
    expect(globalGroup.getAttribute("data-active")).toBe(keyOf("/a"));
  });

  it("the global empty-state card only looks at project groups: all projects empty + global stocked, the empty card shows (below the global group)", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    tabStoreState.activeWorkspacePath = "/a";
    groupReadiness.global = { loaded: true, empty: false, count: 3 };
    groupReadiness["/a"] = { loaded: true, empty: true, count: 0 };
    mount({ workspacePath: "/a" });
    await screen.findByTestId(TID_WORKFLOWS_EMPTY);
    // The global group is still above the empty-state card
    const global = screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    const empty = screen.getByTestId(TID_WORKFLOWS_EMPTY);
    expect(global.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The total includes global
    expect(screen.getByText(expectedCopy("workflows.hub.sectionTitle")).textContent).toContain("3");
  });

  it("all projects empty and global empty too: the empty-state card still appears below the global group", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    tabStoreState.activeWorkspacePath = "/a";
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: true, empty: true, count: 0 };
    const { onCreateViaChat } = mount({ workspacePath: "/a" });
    await screen.findByTestId(TID_WORKFLOWS_EMPTY);
    fireEvent.click(screen.getByTestId(TID_WORKFLOWS_CREATE_VIA_CHAT));
    expect(onCreateViaChat.mock.calls[0]?.[1]).toEqual({
      projectId: "t-/a",
      hostId: "local",
      workspacePath: "/a",
    });
    expect(onCreateViaChat.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("save it to this project"),
    );
  });

  it("spinner: shows while global and all project groups are unready; no empty-state card", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: false, empty: false, count: 0 };
    groupReadiness["/a"] = { loaded: false, empty: false, count: 0 };
    mount();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByTestId(TID_WORKFLOWS_EMPTY)).toBeNull();
  });

  it("once the global group is ready the spinner stops even if project groups are not", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: false, empty: false, count: 0 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("with no candidate projects it still renders the global group and refresh button, plus the open-a-project hint", async () => {
    tabStoreState.tabs = [{ id: "s", kind: "settings", workspacePath: "", label: "settings" }];
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    expect(screen.getByText(expectedCopy("workflows.hub.noWorkspace"))).toBeTruthy();
    expect(screen.getByTestId(TID_WORKFLOWS_REFRESH)).toBeTruthy();
    // With no candidates the empty-state card does not show (that is "all projects empty"; here there are no project groups at all)
    expect(screen.queryByTestId(TID_WORKFLOWS_EMPTY)).toBeNull();
  });

  // launch.md "The hub page" / "The user's choice": the header row carries "Workflow settings"
  // and the currently effective mode; clicking opens Settings › General directly.
  it("the Workflow settings row shows the effective mode and opens Settings on General", async () => {
    useDynamicWorkflowAvailabilityStore.setState({
      status: "ready",
      enabled: true,
      config: applyDynamicWorkflowUserMode(
        createDynamicWorkflowClientConfig("alwaysOn", "remote"),
        "onDemand",
      ),
    });
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    mount();
    const button = await screen.findByTestId(TID_WORKFLOWS_OPEN_SETTINGS);
    expect(button.textContent).toContain(expectedCopy("workflows.hub.openSettings"));
    expect(button.textContent).toContain(expectedCopy("settings.dynamicWorkflow.option.onDemand"));
    fireEvent.click(button);
    expect(settingsNavigation.setPendingSettingsSectionIntent).toHaveBeenCalledWith("general");
    expect(tabStoreState.openSettingsTab).toHaveBeenCalledTimes(1);
  });

  it("a legacy Host snapshot without offeredMode: no Workflow settings link (the settings row it opens does not exist)", async () => {
    useDynamicWorkflowAvailabilityStore.setState({
      status: "ready",
      enabled: true,
      config: { mode: "alwaysOn", enabled: true, source: "remote" } as unknown as ReturnType<
        typeof createDynamicWorkflowClientConfig
      >,
    });
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    mount();
    await screen.findByTestId(TID_WORKFLOWS_REFRESH);
    expect(screen.queryByTestId(TID_WORKFLOWS_OPEN_SETTINGS)).toBeNull();
  });

  it("the refresh button increments refreshSeq and broadcasts to the global group and all project groups", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-refresh")).toBe("0");
    fireEvent.click(screen.getByTestId(TID_WORKFLOWS_REFRESH));
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-refresh")).toBe("1"),
    );
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
        .getAttribute("data-refresh"),
    ).toBe("1");
  });

  // Project groups no longer have onMoved ("promote to global" only opens a session and changes
  // neither group's contents, docs/dynamic-workflow/launch.md addendum 2026-09-04); only the
  // global group's "move to project…" broadcasts.
  it("the global group's onMoved increments refreshSeq for both groups", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    fireEvent.click(screen.getByTestId("global-moved"));
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-refresh")).toBe("1"),
    );
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
        .getAttribute("data-refresh"),
    ).toBe("1");
  });

  it("clicking the global group's open enters global detail: only the global group renders (detail), no project groups", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    fireEvent.click(screen.getByTestId("global-open"));
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-mode")).toBe(
        "detail",
      ),
    );
    expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-name")).toBe("g-1");
    expect(screen.queryByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))).toBeNull();
    expect(screen.queryByTestId(TID_WORKFLOWS_REFRESH)).toBeNull();
    fireEvent.click(screen.getByTestId("global-back"));
    await waitFor(() =>
      expect(screen.getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))).toBeTruthy(),
    );
  });

  it("clicking a project group's open enters project detail: only that project group renders, no global group", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")));
    fireEvent.click(screen.getByTestId("open-/a"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
          .getAttribute("data-mode"),
      ).toBe("detail"),
    );
    expect(screen.queryByTestId(TID_WORKFLOW_GLOBAL_GROUP)).toBeNull();
    expect(screen.queryByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")))).toBeNull();
  });

  it("the active project's group carries the current marker", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    tabStoreState.activeWorkspacePath = "/b";
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 1 };
    mount({ workspacePath: "/b" });
    await screen.findByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")));
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
        .getAttribute("data-current"),
    ).toBe("false");
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")))
        .getAttribute("data-current"),
    ).toBe("true");
  });

  it("the openWorkflow deep link, project variant, lands on project detail and is consumed", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 1 };
    const onOpenWorkflowConsumed = vi.fn();
    mount({ openWorkflow: { workspaceKey: keyOf("/b"), name: "deep" }, onOpenWorkflowConsumed });
    await waitFor(() =>
      expect(
        screen
          .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")))
          .getAttribute("data-mode"),
      ).toBe("detail"),
    );
    expect(
      screen.getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b"))).getAttribute("data-name"),
    ).toBe("deep");
    expect(screen.queryByTestId(TID_WORKFLOW_GLOBAL_GROUP)).toBeNull();
    expect(onOpenWorkflowConsumed).toHaveBeenCalledTimes(1);
  });

  it("the openWorkflow deep link, global variant, lands on global detail and is consumed", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    const onOpenWorkflowConsumed = vi.fn();
    mount({ openWorkflow: { scope: "global", name: "deep-g" }, onOpenWorkflowConsumed });
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-mode")).toBe(
        "detail",
      ),
    );
    expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-name")).toBe("deep-g");
    expect(screen.queryByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))).toBeNull();
    expect(onOpenWorkflowConsumed).toHaveBeenCalledTimes(1);
  });
});
