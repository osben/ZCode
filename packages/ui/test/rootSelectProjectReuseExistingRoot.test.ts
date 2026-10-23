// 桌面打开目录：先按单根 reuseExistingRoot 解析/复用项目，再激活已打开窗口或新增 tab，草稿绑定该项目 id。
// handleSelectProject 依赖大量 Root 状态，这里用源码接线契约锁定顺序与参数（与同目录其它 Root 契约测试一致）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("\r\n", "\n");
}

const hookSource = source("../src/root/useRootWorkspaceActions.ts");
const rootSource = source("../src/Root.tsx");

describe("desktop open directory resolves the project with reuseExistingRoot", () => {
  it("handleSelectProject saves the single root with reuseExistingRoot on desktop before activating a window", () => {
    const handler = hookSource.slice(
      hookSource.indexOf("const handleSelectProject = useCallback("),
    );
    const saveIndex = handler.indexOf(
      "services.projectService.saveProject({ roots: [path], reuseExistingRoot: true })",
    );
    const activateIndex = handler.indexOf("platform.activateOrSetWorkspace(path)");

    expect(saveIndex).toBeGreaterThan(0);
    expect(activateIndex).toBeGreaterThan(saveIndex);
    expect(handler).toContain("if (isDesktop)");
    expect(handler).toContain('throw new Error("project.service-unavailable")');
  });

  it("the resolved project id is passed to the new draft", () => {
    const handler = hookSource.slice(
      hookSource.indexOf("const handleSelectProject = useCallback("),
    );
    expect(handler).toContain(
      "startDraftInWorkspace(path, undefined, projectId ? { projectId } : undefined)",
    );
  });

  it("the hook receives isDesktop and Root passes it", () => {
    expect(hookSource).toContain("  isDesktop = false,\n");
    expect(rootSource).toMatch(/useRootWorkspaceActions\(\{[\s\S]*?\n    isDesktop,/);
  });

  it("open-directory failures are surfaced as the workspace action error", () => {
    const handler = hookSource.slice(
      hookSource.indexOf("const handleSelectProject = useCallback("),
    );
    expect(handler).toContain(
      "setWorkspaceActionError(err instanceof Error ? err.message : String(err))",
    );
  });
});
