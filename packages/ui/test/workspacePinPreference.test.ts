import { describe, expect, it } from "vitest";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  isWorkspaceDragAcrossPinnedBoundary,
  orderWorkspaceTabsByPinned,
} from "@/lib/workspacePinPreference.js";

function tab(id: string): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    label: id,
    workspacePath: `/${id}`,
  };
}

describe("workspacePinPreference ordering helpers", () => {
  it("orders pinned tabs first while preserving manual order in both blocks", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
    expect(orderWorkspaceTabsByPinned(tabs, new Set(["c", "b"])).map((item) => item.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(tabs.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("detects only drags across the pinned boundary", () => {
    const pinned = new Set(["a", "c"]);
    expect(isWorkspaceDragAcrossPinnedBoundary(pinned, "a", "c")).toBe(false);
    expect(isWorkspaceDragAcrossPinnedBoundary(pinned, "b", "d")).toBe(false);
    expect(isWorkspaceDragAcrossPinnedBoundary(pinned, "a", "b")).toBe(true);
    expect(isWorkspaceDragAcrossPinnedBoundary(pinned, "b", "c")).toBe(true);
  });
});
