import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("side-pane terminal working directory", () => {
  it("starts in the execution worktree and resolves the task meta before useAppPanels", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/App.tsx"), "utf8");
    const metaIndex = source.indexOf("} = useWorkspaceActiveTaskState({");
    const panelsIndex = source.indexOf("} = useAppPanels({");
    expect(metaIndex).toBeGreaterThan(-1);
    expect(metaIndex).toBeLessThan(panelsIndex);
    expect(source).toContain(
      "terminalCwd: resolvedActiveTaskMeta?.executionWorktree?.path ?? workspaceAbsPath",
    );
  });
});
