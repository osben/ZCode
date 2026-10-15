import { readSourceText } from "./readSourceText.js";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import ukUA from "@/i18n/locales/uk-UA.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function readWorkspaceSidebarSource(): string {
  return readSourceText(resolve(process.cwd(), "packages/ui/src/WorkspaceSidebar.tsx"), "utf8");
}

describe("WorkspaceSidebar project pins", () => {
  it("renders the pinned partition for both sortable items and rows", () => {
    const source = readWorkspaceSidebarSource();
    expect(source).toContain("items={orderedProjectWorkspaceTabs.map((tab) => tab.id)}");
    expect(source).toContain("{orderedProjectWorkspaceTabs.map((tab, orderedIndex) => {");
    // The raw store order must no longer drive the rendered list.
    expect(source).not.toContain("items={projectWorkspaceTabs.map((tab) => tab.id)}");
  });

  it("clamps cross-boundary drags before resolving reorder indices", () => {
    const source = readWorkspaceSidebarSource();
    const clampIndex = source.indexOf("isWorkspaceDragAcrossPinnedBoundary(");
    const reorderIndex = source.indexOf("resolveWorkspaceDragGlobalIndices({");
    expect(clampIndex).toBeGreaterThan(-1);
    expect(reorderIndex).toBeGreaterThan(clampIndex);
  });

  it("keeps a divider between the pinned and unpinned blocks", () => {
    const source = readWorkspaceSidebarSource();
    expect(source).toContain("TID_WORKSPACE_PIN_DIVIDER");
    expect(source).toContain("orderedIndex === pinnedProjectTabIds.size");
  });

  it("exposes the pin toggle only through the project row menus", () => {
    const itemSource = readSourceText(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarItem.tsx"),
      "utf8",
    );
    expect(itemSource).toContain("TID_WORKSPACE_TOGGLE_PIN");
    expect(itemSource).toContain("onToggleWorkspacePinned(!isPinned)");
    expect(itemSource).toContain('data-testid="workspace-customize"');
    // The pin glyph is a row state indicator, not a drag affordance.
    expect(itemSource).toContain('data-workspace-pinned-indicator="true"');
  });

  it("loads and persists pins through the task service, not local storage", () => {
    const source = readWorkspaceSidebarSource();
    expect(source).toContain("listPinnedWorkspaceKeys()");
    expect(source).toContain("setWorkspacePinned({ workspaceKey, pinned })");
    expect(source).not.toContain("persistWorkspacePinnedPreference");
    expect(source).not.toContain("readPinnedWorkspaceKeys");
  });

  it("does not expose pin actions until the initial pinned-key request settles", () => {
    const source = readWorkspaceSidebarSource();
    expect(source).toMatch(
      /onToggleWorkspacePinned=\{\s*pinnedWorkspaceKeysLoaded\s*\?\s*handleToggleWorkspacePinned\s*:\s*undefined/su,
    );
    expect(source).toContain("if (!pinnedWorkspaceKeysLoaded) return;");
  });

  it("ships pin labels in every locale", () => {
    for (const locale of [enUS, ukUA, zhCN]) {
      expect(locale["workspaceSidebar.pinProject"]).toBeTruthy();
      expect(locale["workspaceSidebar.unpinProject"]).toBeTruthy();
      expect(locale["workspaceSidebar.pinFailed"]).toBeTruthy();
    }
  });
});
