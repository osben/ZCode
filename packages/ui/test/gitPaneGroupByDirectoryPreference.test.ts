import { describe, expect, it } from "vitest";
import { CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY } from "@/lib/changeSummaryTreeViewPreference.js";
import {
  GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY,
  persistGitPaneGroupByDirectoryPreference,
  readGitPaneGroupByDirectoryPreference,
} from "@/lib/gitPaneGroupByDirectoryPreference.js";

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("git pane group-by-directory preference", () => {
  it("defaults to off when nothing is stored", () => {
    expect(readGitPaneGroupByDirectoryPreference(makeStorage())).toBe(false);
  });

  it("treats unknown stored values as off", () => {
    expect(
      readGitPaneGroupByDirectoryPreference(
        makeStorage({ [GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY]: "directory" }),
      ),
    ).toBe(false);
  });

  it("reads on only for the exact stored value 'true'", () => {
    expect(
      readGitPaneGroupByDirectoryPreference(
        makeStorage({ [GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY]: "true" }),
      ),
    ).toBe(true);
  });

  it("round-trips through storage and removes the key when turned off", () => {
    const storage = makeStorage();

    persistGitPaneGroupByDirectoryPreference(true, storage);
    expect(storage.map.get(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY)).toBe("true");
    expect(readGitPaneGroupByDirectoryPreference(storage)).toBe(true);

    persistGitPaneGroupByDirectoryPreference(false, storage);
    expect(storage.map.has(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY)).toBe(false);
    expect(readGitPaneGroupByDirectoryPreference(storage)).toBe(false);
  });

  it("uses a key separate from the chat card preference", () => {
    expect(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY).not.toBe(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY);

    const storage = makeStorage({ [CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY]: "true" });
    expect(readGitPaneGroupByDirectoryPreference(storage)).toBe(false);

    persistGitPaneGroupByDirectoryPreference(false, storage);
    expect(storage.map.get(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY)).toBe("true");
  });

  it("falls back to off and does not throw when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readGitPaneGroupByDirectoryPreference(throwing)).toBe(false);
    expect(() => persistGitPaneGroupByDirectoryPreference(true, throwing)).not.toThrow();
  });
});
