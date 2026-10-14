import { describe, expect, it } from "vitest";
import {
  createWorkspaceDisplayStore,
  selectWorkspaceDisplayEntry,
  type WorkspaceDisplayState,
} from "@/store/workspaceDisplayStore.js";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("workspaceDisplayStore", () => {
  it("persists display name and color changes", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceDisplayStore(storage);

    store.getState().setWorkspaceDisplayName("/repo", "My Repo");
    store.getState().setWorkspaceColor("/repo", "purple");

    const entry = store.getState().entries["/repo"];
    expect(entry).toEqual({ displayName: "My Repo", color: "purple" });

    const persisted = JSON.parse(storage.getItem("zcode-workspace-display") ?? "{}");
    expect(persisted["/repo"]).toEqual({ displayName: "My Repo", color: "purple" });
  });

  it("removing the display name keeps the color and vice versa", () => {
    const store = createWorkspaceDisplayStore(createMemoryStorage());
    store.getState().setWorkspaceDisplayName("/repo", "My Repo");
    store.getState().setWorkspaceColor("/repo", "red");

    store.getState().setWorkspaceDisplayName("/repo", null);
    expect(store.getState().entries["/repo"]).toEqual({ color: "red" });

    store.getState().setWorkspaceColor("/repo", null);
    expect(store.getState().entries["/repo"]).toBeUndefined();
  });

  it("trims blank names to empty entries", () => {
    const store = createWorkspaceDisplayStore(createMemoryStorage());
    store.getState().setWorkspaceDisplayName("/repo", "   ");
    expect(store.getState().entries["/repo"]).toBeUndefined();

    store.getState().setWorkspaceDisplayName("/repo", "  Padded  ");
    expect(store.getState().entries["/repo"]?.displayName).toBe("Padded");
  });

  it("seeds from storage and ignores unknown shapes", () => {
    const seeded = createMemoryStorage({
      "zcode-workspace-display": JSON.stringify({
        "/repo": { displayName: "Seeded", color: "chartreuse-neon" },
        "/kept": { displayName: "Kept", color: "green" },
        "/colors-only": { color: "orange" },
        broken: "string",
      }),
      corrupted: "{not json",
    });
    const store = createWorkspaceDisplayStore(seeded);

    expect(store.getState().entries).toEqual({
      "/repo": { displayName: "Seeded" },
      "/kept": { displayName: "Kept", color: "green" },
      "/colors-only": { color: "orange" },
    });
  });

  it("tolerates corrupted storage payloads", () => {
    const store = createWorkspaceDisplayStore(
      createMemoryStorage({ "zcode-workspace-display": "{not json" }),
    );
    expect(store.getState().entries).toEqual({});
  });

  it("selects the entry by identity fallback key", () => {
    const store = createWorkspaceDisplayStore(createMemoryStorage());
    store.getState().setWorkspaceDisplayName("identity-1", "Remote repo");
    const state: WorkspaceDisplayState = store.getState();

    expect(selectWorkspaceDisplayEntry(state, "/any/path", "identity-1")?.displayName).toBe(
      "Remote repo",
    );
    expect(selectWorkspaceDisplayEntry(state, "/other/path", "identity-1")?.displayName).toBe(
      "Remote repo",
    );
    expect(selectWorkspaceDisplayEntry(state, "/local/path")).toBeUndefined();
  });
});
