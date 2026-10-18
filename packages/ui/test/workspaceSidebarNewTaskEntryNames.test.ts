// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_CONVERSATION_NEW_TASK, type IPlatformService } from "@zcode/shared";
import enUS from "@/i18n/locales/en-US.js";
import ukUA from "@/i18n/locales/uk-UA.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// specs/sidebar-ui-polish.md — "Distinct names for the two New task entry points".
// The conversation-section add button and the top "New task" control lead to different
// workspaces, so they must not share an accessible name (QA MINOR-3 misclick).

const { localeState } = vi.hoisted(() => ({
  localeState: { messages: {} as Record<string, string> },
}));

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserverMock {
    disconnect() {}
    observe() {}
    unobserve() {}
  },
);

const projectTab = {
  id: "tab-project",
  kind: "workspace" as const,
  label: "project",
  workspacePath: "/tmp/project",
  workspacePurpose: "project" as const,
};

const conversationTab = {
  id: "tab-conversation",
  kind: "workspace" as const,
  label: "default",
  workspacePath: "/tmp/.zcode/workspace/default",
  workspacePurpose: "conversation" as const,
};

const tabStoreState = {
  activeTabId: projectTab.id,
  tabs: [projectTab, conversationTab],
  expandedWorkspacePaths: new Set([projectTab.workspacePath]),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  collapseAllWorkspaceTabs: vi.fn(),
  expandAllWorkspaceTabs: vi.fn(),
  openSettingsTab: vi.fn(),
  reorderWorkspaceTabs: vi.fn(),
  toggleWorkspaceExpanded: vi.fn(),
};

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DragOverlay: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  KeyboardSensor: function KeyboardSensor() {},
  PointerSensor: function PointerSensor() {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    isDragging: false,
    listeners: {},
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
  })),
  verticalListSortingStrategy: {},
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/NewTaskButtonGroup.js", () => ({
  NewTaskButtonGroup: () => createElement("div", { "data-testid": "new-task-button-group" }),
}));

vi.mock("@/TaskSearchDialog.js", () => ({
  TaskSearchDialog: () => null,
}));

vi.mock("@/BotsDialog.js", () => ({
  BotsDialog: () => null,
}));

vi.mock("@/WorkspaceArchivedTasksFlatSection.js", () => ({
  WorkspaceArchivedTasksFlatSection: () => null,
}));

vi.mock("@/WorkspacePinnedTasksSection.js", () => ({
  WorkspacePinnedTasksSection: () => null,
}));

vi.mock("@/WorkspaceTimelineTasksSection.js", () => ({
  WorkspaceTimelineTasksSection: () => createElement("div", { "data-testid": "timeline-tasks" }),
}));

vi.mock("@/WorkspaceGroupedTasksSection.js", () => ({
  WorkspaceGroupedTasksSection: () => createElement("div", { "data-testid": "grouped-tasks" }),
}));

vi.mock("@/WorkspaceSidebarFooter.js", () => ({
  WorkspaceSidebarFooter: () => createElement("footer", { "data-testid": "sidebar-footer" }),
}));

vi.mock("@/SortableWorkspaceSidebar.js", () => ({
  SortableWorkspaceSidebarItem: ({ tab }: { tab: typeof projectTab }) =>
    createElement("li", { "data-testid": "workspace-sidebar-item" }, tab.label),
  restrictVerticalDragWithinContainer: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceTaskLists.js", () => ({
  useWorkspaceTaskLists: () => ({
    groups: [],
    loadingByWorkspaceKey: {},
  }),
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

vi.mock("@/store/zcodeSessionStore.js", () => ({
  selectWorkspaceZCodeState: () => ({ activeTaskId: null }),
  useZCodeSessionStore: (selector: (state: { selectDraftProvider: () => void }) => unknown) =>
    selector({ selectDraftProvider: vi.fn() }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: { setTheme: () => void }) => unknown) =>
    selector({ setTheme: vi.fn() }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof tabStoreState) => unknown) => selector(tabStoreState),
}));

vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({
    openCodingPlanUpgrade: vi.fn(),
  }),
}));

async function renderDesktopSidebar(onCreateConversationTask: () => void) {
  const { WorkspaceSidebar } = await import("@/WorkspaceSidebar.js");
  const { ServiceProvider } = await import("@/hooks/useServices.js");
  const { PlatformProvider } = await import("@/hooks/usePlatform.js");
  const { createSettingsTestServices } = await import("./lib/settingsTestServices.js");
  const props = {
    isDesktop: true,
    isWindowsDesktop: false,
    onCancelRemoteProject: vi.fn(async () => {}),
    onConnectRemote: vi.fn(async () => ""),
    onCreateTask: vi.fn(),
    onCreateConversationTask,
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    onSelectRemoteProject: vi.fn(async () => {}),
    onSelectTask: vi.fn(),
    reconnectingRemoteWorkspaceKeys: [],
    remoteWorkspaceErrorByWorkspaceKey: {},
    selectedProvider: "codex",
    taskOrganizeBy: "project",
    theme: "light",
    user: null,
    workspacePath: projectTab.workspacePath,
  };

  return render(
    createElement(
      ServiceProvider,
      { services: createSettingsTestServices() },
      createElement(
        PlatformProvider,
        { platform: {} as unknown as IPlatformService },
        createElement(WorkspaceSidebar, props as unknown as Parameters<typeof WorkspaceSidebar>[0]),
      ),
    ),
  );
}

describe("WorkspaceSidebar New task entry names", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([
    ["en-US", enUS],
    ["uk-UA", ukUA],
    ["zh-CN", zhCN],
  ])(
    "names the conversation-section button differently from the top New task (%s)",
    async (_locale, messages) => {
      localeState.messages = messages;
      const onCreateConversationTask = vi.fn();
      const { container } = await renderDesktopSidebar(onCreateConversationTask);

      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid="${TID_CONVERSATION_NEW_TASK}"]`,
      );
      expect(button).not.toBeNull();
      const accessibleName = button?.getAttribute("aria-label") ?? "";
      expect(accessibleName.trim()).not.toBe("");
      // The top sidebar control (NewTaskButtonGroup) and the collapsed-sidebar overlay button
      // render these two keys respectively.
      expect(accessibleName).not.toBe(messages["taskList.newThread"]);
      expect(accessibleName).not.toBe(messages["sidebar.newTask"]);

      fireEvent.click(button as HTMLButtonElement);
      expect(onCreateConversationTask).toHaveBeenCalledTimes(1);
    },
    15_000,
  );
});
