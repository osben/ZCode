// @vitest-environment jsdom

// Ruling on where an artifact click lands (docs/dynamic-workflow/authoring.md "How the user sees them").
//
// ⚠ Terminology: artifact = output delivered **to the user** by the script via `artifact.*`, not a synonym for the
// engine-internal "script top-level return value".
//
// Pins three things:
//   1. html + local workspace + embedded browser ⇒ open a browser tab directly, never going through the artifact tab;
//   2. clicking the same artifact again ⇒ reuse that one tab and **re-issue** the navigation request (v2 must show
//      the new bytes);
//   3. any criterion failing, provenance not found, or the query itself failing ⇒ fall back to the artifact tab;
//      the click never lands nowhere.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationWorkflowRunArtifactsResult } from "@zcode/shared/zcode-protocol-v4";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { clearTaskSidePaneMemoryStateForTest } from "@/lib/taskSidePaneMemory.js";
import { getVisibleSidePaneTabs } from "@/lib/workspaceSidePane.js";
import type {
  OpenScopedWorkflowArtifactSideTabRequest,
  WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";

const { conversationWorkflowRunArtifactsV4 } = vi.hoisted(() => ({
  conversationWorkflowRunArtifactsV4:
    vi.fn<() => Promise<V4ConversationWorkflowRunArtifactsResult>>(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    zcodeAgentService: { conversationWorkflowRunArtifactsV4 },
    zcodeSessionService: { closeSession: vi.fn(async () => {}) },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const WORKSPACE_PATH = "/repo";
const SESSION_ID = "sess-a";
const REPORT_URL = "file:///repo/.zcode/workflow-runs/run-1/report.html";

function renderPanels(options?: { supportsEmbeddedBrowser?: boolean; sidePaneOwnerId?: string }) {
  return renderHook(() =>
    useAppPanels({
      workspaceAbsPath: WORKSPACE_PATH,
      activeTaskId: options?.sidePaneOwnerId ?? SESSION_ID,
      sidePaneOwnerId: options?.sidePaneOwnerId ?? SESSION_ID,
      isDesktop: true,
      isWorkspaceVisible: true,
      supportsEmbeddedBrowser: options?.supportsEmbeddedBrowser ?? true,
      defaultWhiteboardNamePrefix: "Whiteboard",
    }),
  );
}

function artifactRequest(
  overrides: Partial<OpenScopedWorkflowArtifactSideTabRequest> = {},
): OpenScopedWorkflowArtifactSideTabRequest {
  return {
    workspacePath: WORKSPACE_PATH,
    parentSessionId: SESSION_ID,
    runId: "run-1",
    artifactId: "report",
    contentType: "text/html",
    ...overrides,
  };
}

function journalResult(sourcePath?: string): V4ConversationWorkflowRunArtifactsResult {
  return {
    artifacts: [
      {
        id: "report",
        kind: "file",
        contentType: "text/html",
        version: 1,
        versions: [{ version: 1, publishedAt: 1, ...(sourcePath ? { sourcePath } : {}) }],
        itemCount: 0,
        ...(sourcePath ? { sourcePath } : {}),
      },
    ],
  };
}

function tabTypes(tabs: WorkspaceSidePaneTab[] | undefined): string[] {
  return (tabs ?? []).map((tab) => tab.type);
}

/** The hook's internal journal query is a fire-and-forget async IIFE; drain the microtasks fully. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("产物落点判据", () => {
  it("只有 html + 本地 workspace + 有内嵌浏览器三条同时成立才直开", () => {
    const base = { contentType: "text/html", supportsEmbeddedBrowser: true };
    expect(shouldOpenWorkflowArtifactInBrowser(base)).toBe(true);
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, contentType: "text/markdown" })).toBe(
      false,
    );
    // A parameterized content type goes to the artifact tab: the same strict gate as for painting an html card.
    expect(
      shouldOpenWorkflowArtifactInBrowser({ ...base, contentType: "text/html; charset=utf-8" }),
    ).toBe(false);
    expect(shouldOpenWorkflowArtifactInBrowser({ supportsEmbeddedBrowser: true })).toBe(false);
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, supportsEmbeddedBrowser: false })).toBe(
      false,
    );
    expect(
      shouldOpenWorkflowArtifactInBrowser({ ...base, workspaceIdentity: "ssh://host/repo" }),
    ).toBe(false);
    // A blank identity does not count as remote (same source as canRevealArtifactInWorkspace).
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, workspaceIdentity: "  " })).toBe(true);
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, remoteSessionId: "remote-a" })).toBe(
      false,
    );
  });
});

describe("useAppPanels 打开工作流产物", () => {
  beforeEach(() => {
    clearTaskSidePaneMemoryStateForTest();
    conversationWorkflowRunArtifactsV4.mockReset();
  });

  it("html 产物直接开 browser tab，不再开产物 tab", async () => {
    conversationWorkflowRunArtifactsV4.mockResolvedValue(
      journalResult(".zcode/workflow-runs/run-1/report.html"),
    );
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    const tabs = result.current.sidePaneState?.tabs ?? [];
    expect(tabTypes(tabs)).toEqual(["browser"]);
    const tab = tabs[0];
    expect(tab?.type === "browser" ? tab.initialUrl : null).toBe(REPORT_URL);
    expect(result.current.sidePaneState?.activeTabId).toBe(tab?.id);
    expect(result.current.isSidePaneCollapsed).toBe(false);
    expect(result.current.browserNavigationRequest).toMatchObject({
      targetTabId: tab?.id,
      url: REPORT_URL,
    });
    expect(conversationWorkflowRunArtifactsV4).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      sessionId: SESSION_ID,
      runId: "run-1",
    });
    unmount();
  });

  it("再点一次复用同一个 browser tab，并重新发导航请求", async () => {
    conversationWorkflowRunArtifactsV4.mockResolvedValue(
      journalResult(".zcode/workflow-runs/run-1/report.html"),
    );
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();
    const firstTabId = result.current.sidePaneState?.tabs[0]?.id;
    const firstRequestId = result.current.browserNavigationRequest?.id;

    // Switch away in between, to confirm the second click reactivates it.
    act(() => {
      result.current.handleOpenGit();
    });
    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    const tabs = result.current.sidePaneState?.tabs ?? [];
    expect(tabs.filter((tab) => tab.type === "browser")).toHaveLength(1);
    expect(tabs[0]?.id).toBe(firstTabId);
    expect(result.current.sidePaneState?.activeTabId).toBe(firstTabId);
    // Same landing spot, new request id: after v2 republishes, the webview must re-fetch the bytes.
    expect(result.current.browserNavigationRequest?.targetTabId).toBe(firstTabId);
    expect(result.current.browserNavigationRequest?.id).not.toBe(firstRequestId);
    expect(result.current.browserNavigationRequest?.url).toBe(REPORT_URL);
    unmount();
  });

  it("远程 workspace 的 html 产物仍开产物 tab", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ workspaceIdentity: "ssh://host/repo" }),
      );
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("手机远控（remoteSessionId）的 html 产物仍开产物 tab", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest({ remoteSessionId: "remote-a" }));
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("没有内嵌浏览器的壳层仍开产物 tab", async () => {
    const { result, unmount } = renderPanels({ supportsEmbeddedBrowser: false });

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("非 html 与 contentType 缺席都开产物 tab，且不查 journal", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ artifactId: "notes", contentType: "text/markdown" }),
      );
    });
    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ artifactId: "legacy", contentType: undefined }),
      );
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual([
      "workflow-artifact",
      "workflow-artifact",
    ]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("journal 查询失败时退回产物 tab", async () => {
    conversationWorkflowRunArtifactsV4.mockRejectedValue(new Error("capabilityUnsupported"));
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(result.current.browserNavigationRequest).toBeNull();
    unmount();
  });

  it("产物没有工作区出处时退回产物 tab", async () => {
    conversationWorkflowRunArtifactsV4.mockResolvedValue(journalResult(undefined));
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(result.current.browserNavigationRequest).toBeNull();
    unmount();
  });

  it("中枢那条路径上 owner ref 还没追上时，browser tab 仍归属目标会话", async () => {
    // handleOpenSavedWorkflowArtifact calls handleSelectTaskInChat and then opens the artifact within the same
    // synchronous block, so at click time sidePaneOwnerId still points at the previous session. The browser tab's
    // visibility narrows by ownerTaskId; if it were stamped with the old session, the tab would disappear once the
    // switch settles.
    const { result, unmount } = renderPanels({ sidePaneOwnerId: "sess-previous" });

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ sourcePath: ".zcode/workflow-runs/run-1/report.html" }),
      );
    });
    await flush();

    const tabs = result.current.sidePaneState?.tabs ?? [];
    expect(tabTypes(tabs)).toEqual(["browser"]);
    expect(tabs[0]).toMatchObject({ ownerTaskId: SESSION_ID, workspaceKey: WORKSPACE_PATH });
    // After the switch settles (scope = target session), this tab must still be in the visible set.
    expect(
      getVisibleSidePaneTabs(tabs, {
        workspaceKey: WORKSPACE_PATH,
        ownerTaskId: SESSION_ID,
      }).map((tab) => tab.id),
    ).toEqual([tabs[0]?.id]);
    expect(result.current.sidePaneState?.activeTabId).toBe(tabs[0]?.id);
    unmount();
  });

  it("请求自带 sourcePath 时不查 journal", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ sourcePath: ".zcode/workflow-runs/run-1/report.html" }),
      );
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["browser"]);
    const tab = result.current.sidePaneState?.tabs[0];
    expect(tab?.type === "browser" ? tab.initialUrl : null).toBe(REPORT_URL);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });
});
