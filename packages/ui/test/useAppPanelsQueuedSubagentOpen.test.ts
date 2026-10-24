// @vitest-environment jsdom
// Sidebar subagent rows queue the right-pane tab until the parent owns the side pane
// (spec: sidebar-child-conversation-counts.md §8.2).
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { clearTaskSidePaneMemoryStateForTest } from "@/lib/taskSidePaneMemory.js";

vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeSessionService: { closeSession: vi.fn(async () => {}) } }),
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

type Scope = { workspaceIdentity: string; ownerTaskId: string | null };
const current: Scope = { workspaceIdentity: "", ownerTaskId: "other-task" };

function setup() {
  return renderHook(
    (scope: Scope) =>
      useAppPanels({
        workspaceAbsPath: "/repo",
        workspaceIdentity: scope.workspaceIdentity,
        activeTaskId: scope.ownerTaskId,
        sidePaneOwnerId: scope.ownerTaskId,
        isDesktop: true,
        supportsEmbeddedBrowser: true,
        defaultWhiteboardNamePrefix: "Whiteboard",
        platform: { browserViewCloseTab: vi.fn(async () => {}) },
      }),
    { initialProps: current },
  );
}

function request(workspaceIdentity?: string) {
  return {
    workspacePath: "/repo",
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    rootSessionId: "parent",
    parentSessionId: "parent",
    childSessionId: "child",
    subagentType: "",
    title: "Child",
  };
}

const subagentTabs = (h: ReturnType<typeof setup>) =>
  h.result.current.sidePaneState?.tabs.filter((tab) => tab.type === "subagent-session") ?? [];

describe("queued sidebar subagent open", () => {
  beforeEach(clearTaskSidePaneMemoryStateForTest);
  afterEach(() => {
    cleanup();
    clearTaskSidePaneMemoryStateForTest();
  });

  it("opens the tab only once the parent is the active owner, then shows it expanded", () => {
    const h = setup();
    act(() => h.result.current.handleQueueSubagentSessionOpen(request()));
    expect(subagentTabs(h)).toEqual([]);
    h.rerender({ ...current, ownerTaskId: "parent" });
    expect(subagentTabs(h)).toHaveLength(1);
    expect(subagentTabs(h)[0]).toMatchObject({
      rootSessionId: "parent",
      parentSessionId: "parent",
      childSessionId: "child",
      title: "Child",
    });
    expect(h.result.current.sidePaneState?.activeTabId).toBe(subagentTabs(h)[0]!.id);
    expect(h.result.current.isSidePaneCollapsed).toBe(false);
    // Consumed exactly once: a later scope change does not reopen a closed tab.
    h.rerender(current);
    h.rerender({ ...current, ownerTaskId: "parent" });
    expect(subagentTabs(h)).toHaveLength(1);
  });

  it("opens into the target workspace after a cross-workspace switch", () => {
    const h = setup();
    act(() => h.result.current.handleQueueSubagentSessionOpen(request("ssh://two/repo")));
    h.rerender({ workspaceIdentity: "", ownerTaskId: "parent" });
    expect(subagentTabs(h)).toEqual([]);
    h.rerender({ workspaceIdentity: "ssh://two/repo", ownerTaskId: "parent" });
    expect(subagentTabs(h)).toHaveLength(1);
    expect(subagentTabs(h)[0]).toMatchObject({ workspaceKey: "ssh://two/repo" });
  });

  it("a newer selection clears the pending open", () => {
    const h = setup();
    act(() => h.result.current.handleQueueSubagentSessionOpen(request()));
    act(() => h.result.current.handleQueueSubagentSessionOpen(null));
    h.rerender({ ...current, ownerTaskId: "parent" });
    expect(subagentTabs(h)).toEqual([]);
  });
});
