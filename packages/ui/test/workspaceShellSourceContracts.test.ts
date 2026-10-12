import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let layoutSource = "";

beforeAll(async () => {
  // 同一套源码契约共享不可变 fixture，避免每个测试文件重复读取大型布局源码。
  layoutSource = await readFile(
    new URL("../src/app-shell/WorkspaceShellLayout.tsx", import.meta.url),
    "utf8",
  );
});

function readCallbackBody(source: string, callbackName: string) {
  const marker = `const ${callbackName} = useCallback(`;
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const nextCallbackMatch = /\n\s+const \w+ = useCallback\(/u.exec(
    source.slice(markerIndex + marker.length),
  );
  const nextCallbackIndex = nextCallbackMatch
    ? markerIndex + marker.length + nextCallbackMatch.index
    : source.length;
  return source.slice(markerIndex, nextCallbackIndex);
}

describe("WorkspaceShellLayout render stability source guards", () => {
  it("memoizes scoped error boundary reset key arrays", () => {
    expect(layoutSource).toContain("workspaceOnlyResetKeys = useMemo");
    expect(layoutSource).toContain("workspaceDraftResetKeys = useMemo");
    expect(layoutSource).toContain("workspaceSidebarVisibilityResetKeys = useMemo");
    expect(layoutSource).not.toContain("resetKeys={[workspaceKey]");
  });
});

describe("WorkspaceShellLayout resize auto-collapse", () => {
  it("waits for window resize idle before collapsing conversation panels", () => {
    expect(layoutSource).toContain("CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS");
    expect(layoutSource).toContain("conversationAutoCollapseResizeTimerRef");
    expect(layoutSource).toMatch(/window\.setTimeout\(\s*\(\) => \{/u);
    expect(layoutSource).toMatch(/\},\s*CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS,?\s*\);/u);
    expect(layoutSource).toContain(
      "window.clearTimeout(conversationAutoCollapseResizeTimerRef.current)",
    );
    expect(layoutSource).not.toContain("conversationAutoCollapseFrameRef");
  });
});

describe("WorkspaceShellLayout sidebar resize performance", () => {
  it("keeps drag-time sidebar width updates outside React state", () => {
    const resizeMoveBody = readCallbackBody(layoutSource, "handleWorkspaceSidebarResizeMove");

    expect(layoutSource).toContain("applyWorkspaceSidebarWidthDuringDrag");
    expect(resizeMoveBody).toContain("applyWorkspaceSidebarWidthDuringDrag(nextWidthPx)");
    expect(resizeMoveBody).not.toContain("setWorkspaceSidebarPanelWidthPx");
  });

  it("marks active sidebar resizing through DOM attributes instead of React state", () => {
    const resizeStartBody = readCallbackBody(layoutSource, "handleWorkspaceSidebarResizeStart");
    const resizeFinishBody = readCallbackBody(layoutSource, "finishWorkspaceSidebarResize");

    expect(layoutSource).toContain("setWorkspaceSidebarResizeActive");
    expect(layoutSource).toContain("data-workspace-shell");
    expect(layoutSource).toContain("data-[workspace-sidebar-resizing=true]:transition-opacity");
    expect(resizeStartBody).toContain("setWorkspaceSidebarResizeActive({");
    expect(resizeStartBody).toContain("active: true");
    expect(resizeFinishBody).toContain("setWorkspaceSidebarResizeActive({");
    expect(resizeFinishBody).toContain("active: false");
    expect(layoutSource).not.toContain("isWorkspaceSidebarResizing");
    expect(layoutSource).not.toContain("setIsWorkspaceSidebarResizing");
  });

  // M3 竖切：ChatView 滚动 hook 已删；sidebar drag 跳过 scroll layout 的 v4 等价实现归 M5 分屏期。
  it.skip("lets chat scroll code skip layout metrics during sidebar drag", async () => {
    const [scrollSource, resizeStateSource] = await Promise.all([
      readFile(new URL("../src/ChatView/useChatConversationScroll.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/workspaceSidebarResizeState.ts", import.meta.url), "utf8"),
    ]);

    expect(scrollSource).toContain("isWorkspaceSidebarResizeActiveForElement");
    expect(scrollSource).toContain("WORKSPACE_SIDEBAR_RESIZE_END_EVENT");
    expect(scrollSource).toContain("addEventListener");
    expect(resizeStateSource).toContain("WORKSPACE_SIDEBAR_RESIZE_END_EVENT");
    expect(resizeStateSource).toContain("dispatchEvent");
    expect(scrollSource).toContain("return;");
    expect(scrollSource).toContain("workspace sidebar resize");
  });
});
