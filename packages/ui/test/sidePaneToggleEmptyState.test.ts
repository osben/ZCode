import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("side pane toggle empty state", () => {
  it("keeps the header toggle free of implicit tab creation fallbacks", () => {
    const source = readSource("packages/ui/src/App.tsx");
    const start = source.indexOf("const handleToggleSidePane = useCallback");
    const end = source.indexOf("const runVisibleWorkspaceCommand", start);
    const toggleSource = source.slice(start, end);

    expect(toggleSource).toContain("handleToggleSidePaneCollapse();");
    expect(toggleSource).not.toContain("handleToggleBrowser(");
    expect(toggleSource).not.toContain("handleToggleGit(");
    expect(toggleSource).not.toContain("handleOpenGit(");
  });

  it("renders an Open tab launcher when the side pane has no tabs", () => {
    // Upstream 3.16.1 replaced the row-list launcher with the @container/launcher grid
    // (SidePaneLauncherRow). These invariants keep the empty-state contract: the launcher
    // replaces an empty tab list, and the content layer stays mounted but hidden when no tab is visible.
    const source = readSource("packages/ui/src/app-shell/AnimatedSidePanePanel.tsx");

    expect(source).toContain('id: "terminal"');
    expect(source).toContain('id: "browser"');
    expect(source).toContain('id: "review"');
    expect(source).toContain('id: "selection-side-conversation"');
    expect(source).toContain('id: "sidePane.openTab"');
    expect(source).toContain("hasRenderedSidePane && (sidePaneState || fullView) ? (");
    expect(source).toContain('tab.type === "new-tab" ? (');
    expect(source).toContain("openTabLauncher");
    expect(source).toContain("side-pane-open-tab-shell @container/launcher");
    expect(source).toContain("@min-[36rem]/launcher:grid-cols-2");
    expect(source).toContain(
      '!hasVisibleTabs && !screenshotSurfaceRequest && !fullView && "hidden"',
    );
    expect(source).toContain("<SidePaneLauncherRow");
    expect(source).not.toContain(
      '<div className="flex h-12 shrink-0 items-center justify-end border-b border-border px-3">',
    );
  });

  it("collapses the side pane after closing the final tab", () => {
    const source = readSource("packages/ui/src/hooks/useAppPanels.ts");
    const commitStart = source.indexOf("const commitSidePaneState = useCallback");
    const commitEnd = source.indexOf("\n  const ", commitStart + 1);
    const commitSource = source.slice(commitStart, commitEnd);

    expect(commitStart).toBeGreaterThanOrEqual(0);
    expect(commitSource).toContain(
      "getVisibleSidePaneTabs(next?.tabs ?? [], currentSidePaneScope()).length === 0",
    );
    expect(commitSource).toContain("setIsSidePaneCollapsed(true);");
    expect(commitSource).not.toContain("setIsSidePaneCollapsed(false);");

    const closeSelectedStart = source.indexOf("const closeSelectedSidePaneTabs = useCallback");
    const closeTabStart = source.indexOf("const handleCloseSidePaneTab = useCallback");
    const closeOtherTabStart = source.indexOf(
      "const handleCloseOtherSidePaneTabs = useCallback",
      closeTabStart,
    );
    const closeSelectedSource = source.slice(closeSelectedStart, closeTabStart);
    const closeTabSource = source.slice(closeTabStart, closeOtherTabStart);

    expect(closeTabSource).toContain("closeSelectedSidePaneTabs(");
    expect(closeSelectedSource).toContain("commitSidePaneState((current) =>");
    expect(closeSelectedSource).toContain("closeSidePaneTabs(");

    const closeAllStart = source.indexOf("const handleCloseAllSidePaneTabs = useCallback");
    const reopenStart = source.indexOf("const handleReopenClosedSidePaneTab = useCallback");
    const closeAllSource = source.slice(closeAllStart, reopenStart);

    expect(closeAllSource).toContain("closeSelectedSidePaneTabs(");
  });

  it("截图准备不参与侧栏展开，surface 改由固定的后台承载层提供尺寸", () => {
    const source = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    const sidePanePanelStart = source.indexOf(
      "} = useAnimatedResizablePanel({",
      source.indexOf("sidePanePanelRef"),
    );
    const sidePanePanelEnd = source.indexOf("const mobileSidePanePanelRef", sidePanePanelStart);
    const panelSource = source.slice(sidePanePanelStart, sidePanePanelEnd);

    expect(panelSource).toContain('open: workspaceMainView === "chat" && isSidePaneOpen');
    expect(panelSource).not.toContain("Boolean(screenshotSurfaceRequest)");

    const browserSource = readSource("packages/ui/src/browser-use/BrowserUseSidePaneContent.tsx");
    expect(browserSource).toContain('position: "fixed"');
    expect(browserSource).toContain("left: 0");
    expect(browserSource).toContain("viewport.height + 48");
  });

  it("switching conversation scope applies the resolved active tab and collapsed state together", () => {
    const source = readSource("packages/ui/src/hooks/useAppPanels.ts");
    const start = source.indexOf("const scopeKey =");
    const end = source.indexOf("const handleOpenCodeViewer", start);
    const scopeSyncSource = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(scopeSyncSource).toContain("resolveSidePaneScopeState(");
    expect(scopeSyncSource).toContain("setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);");
    expect(scopeSyncSource).toContain("return resolved.sidePaneState;");
  });

  it("BrowserViewReady 只在 origin session 仍 active 时展开并激活", () => {
    const source = readSource("packages/ui/src/hooks/useAppPanels.ts");
    const start = source.indexOf("const handleBrowserViewReady = useCallback");
    const end = source.indexOf("useEffect(() =>", start);
    const handlerSource = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(handlerSource).toContain("revealSidePaneForCurrentOwner();");
    expect(handlerSource).toContain("applyBrowserUseSidePaneEvent(");
    expect(handlerSource).toContain("ownerTaskId: sidePaneOwnerIdRef.current");
    expect(handlerSource).toContain("if (result.shouldReveal)");
    expect(handlerSource).toContain('result.shouldReveal ? "展开并激活" : "后台挂载"');
  });
});
