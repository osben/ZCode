// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createWorkspaceDisplayStore,
  selectWorkspaceDisplayEntry,
  useWorkspaceDisplayStore,
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

  it("merges a window's workspace update with the latest persisted entries", () => {
    const storage = createMemoryStorage();
    const firstWindow = createWorkspaceDisplayStore(storage);
    const secondWindow = createWorkspaceDisplayStore(storage);

    firstWindow.getState().setWorkspaceDisplayName("/repo/a", "A");
    secondWindow.getState().setWorkspaceDisplayName("/repo/b", "B");

    expect(JSON.parse(storage.getItem("zcode-workspace-display") ?? "{}")).toEqual({
      "/repo/a": { displayName: "A" },
      "/repo/b": { displayName: "B" },
    });
    expect(secondWindow.getState().entries).toEqual({
      "/repo/a": { displayName: "A" },
      "/repo/b": { displayName: "B" },
    });
  });

  it("reloads other-window changes from the localStorage event", () => {
    localStorage.setItem(
      "zcode-workspace-display",
      JSON.stringify({ "/repo/b": { color: "blue" } }),
    );
    useWorkspaceDisplayStore.setState({ entries: { "/repo/a": { displayName: "Stale" } } });

    window.dispatchEvent(new StorageEvent("storage", { key: "zcode-workspace-display" }));

    expect(useWorkspaceDisplayStore.getState().entries).toEqual({
      "/repo/b": { color: "blue" },
    });
    localStorage.removeItem("zcode-workspace-display");
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
