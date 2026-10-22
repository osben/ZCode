// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSidebarProps, ProjectTree } from "@/project-sidebar/contract.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { createSettingsTestServices } from "./lib/settingsTestServices.js";
import enUS from "@/i18n/locales/en-US.js";
import ukUA from "@/i18n/locales/uk-UA.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// specs/sidebar-new-task-outside-project.md. The top "New task" (projects view, inherits the active
// project) and the conversation-section "+" (creates a task outside any project) must carry different
// accessible names, and the "+" must create with projectId: null.

const { localeState, fixture } = vi.hoisted(() => ({
  localeState: { messages: {} as Record<string, string> },
  fixture: {
    state: { tabs: [], activeWorkspaceIdentity: null, openSettingsTab: vi.fn() },
    tree: { projects: [], tasks: [] } as ProjectTree,
  },
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => {
  const base = {
    sourceServerManagementService: {
      getSnapshot: vi.fn(async () => ({ servers: [], profiles: [], states: [] })),
      onDidChangeState: () => ({ dispose() {} }),
    },
    projectService: { readTree: async () => fixture.tree },
    remoteProjectService: {
      readDirectory: async () => ({ hosts: [], entries: [] }),
      refreshEntry: async () => true,
      connectHost: vi.fn(),
      removeHost: vi.fn(),
      removeEntry: vi.fn(),
    },
    zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose: vi.fn() }) },
    broadcastService: { onMessage: () => ({ dispose: vi.fn() }) },
  };
  return {
    useBaseWorkspaceServices: () => base,
    useWorkspaceServices: () => ({
      ...base,
      gitService: { getRepositoryRemotes: async () => ({ remotes: [] }) },
    }),
  };
});
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  useOptionalTabStore: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  useTabStoreApi: () => ({ getState: () => fixture.state, subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
    {
      subscribe: () => () => {},
      getState: () => ({ getWorkspaceState: () => ({ activeTaskId: null }) }),
    },
  ),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) => selector({ setTheme: vi.fn() }),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => localeState.messages[id] ?? id,
    },
    localePreference: "en-US",
    setLocalePreference: vi.fn(),
  }),
}));
// The shortcut hint is not under test; skip the settings/platform chain it would need.
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => "",
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: vi.fn() }),
}));
vi.mock("@/components/manual-claim-plan/ManualClaimPlanBanner.js", () => ({
  ManualClaimPlanBanner: () => null,
}));
vi.mock("@/WorkspaceSidebarFooter.js", () => ({
  WorkspaceSidebarFooter: () => createElement("footer", {}, "Footer"),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
vi.mock("@/project-sidebar/useProjectTaskNavigation.js", () => ({
  useProjectTaskNavigation: (props: ProjectSidebarProps) => props.onSelectTask,
}));
import { ProjectSidebar } from "@/project-sidebar/index.js";

function Sidebar(props: ProjectSidebarProps): ReactNode {
  return createElement(
    ServiceProvider,
    { services: createSettingsTestServices() },
    createElement(
      TooltipProvider,
      null,
      createElement(
        ProjectDirectoryProvider,
        { isDesktop: props.isDesktop },
        createElement(ProjectSidebar, props),
      ),
    ),
  );
}

function props(overrides: Partial<ProjectSidebarProps> = {}): ProjectSidebarProps {
  return {
    workspacePath: "/local",
    theme: "light",
    isDesktop: true,
    onSelectTask: vi.fn(),
    onCreateTask: vi.fn(),
    onCreateConversationTask: vi.fn(),
    onStartDraftInWorkspace: vi.fn(),
    onOpenFolderFromWorkspaceMenu: vi.fn(),
    onConnectRemote: vi.fn(async () => "logical"),
    onSelectRemoteProject: vi.fn(async () => {}),
    onCancelRemoteProject: vi.fn(async () => {}),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    reconnectingRemoteWorkspaceKeys: [],
    remoteWorkspaceErrorByWorkspaceKey: {},
    onOpenCommandCenter: vi.fn(),
    ...overrides,
  } as ProjectSidebarProps;
}

beforeEach(() => {
  fixture.tree = { projects: [], tasks: [] };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each([
  ["en-US", enUS],
  ["uk-UA", ukUA],
  ["zh-CN", zhCN],
])("project sidebar New task entry names (%s)", (_locale, messages) => {
  it("names the conversation + outside the top New task name and keeps both names distinct", () => {
    localeState.messages = messages;
    render(createElement(Sidebar, props()));

    const plus = screen.getByTestId("virtual-project-new-task");
    const plusName = plus.getAttribute("aria-label") ?? "";
    const top = screen.getByText(messages["taskList.newThread"]!);

    expect(plusName).toBe(messages["workspaceSidebar.newTaskOutsideProject"]);
    expect(plusName.trim()).not.toBe("");
    expect(plusName).not.toBe(top.textContent);
    expect(plusName).not.toBe(messages["taskList.newThread"]);
    expect(plusName).not.toBe(messages["sidebar.newTask"]);
  });

  it("creates from the conversation + with projectId null and from the top entry with inherited ownership", () => {
    localeState.messages = messages;
    const onCreateTask = vi.fn();
    render(createElement(Sidebar, props({ onCreateTask })));

    fireEvent.click(screen.getByTestId("virtual-project-new-task"));
    expect(onCreateTask).toHaveBeenNthCalledWith(1, { projectId: null, taskGroupId: null });

    const navigation = screen.getByTestId("sidebar-primary-navigation");
    fireEvent.click(within(navigation).getByText(messages["taskList.newThread"]!));
    expect(onCreateTask).toHaveBeenNthCalledWith(2);
  });
});
