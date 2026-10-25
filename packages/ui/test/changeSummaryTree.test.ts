import { describe, expect, it } from "vitest";
import { buildChangeSummaryTree } from "@/lib/changeSummaryTree.js";
import {
  CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY,
  persistChangeSummaryTreeViewPreference,
  readChangeSummaryTreeViewPreference,
} from "@/lib/changeSummaryTreeViewPreference.js";

const f = (relativePath: string, added = 1, removed = 0) => ({
  path: `/w/${relativePath}`,
  relativePath,
  added,
  removed,
});

describe("buildChangeSummaryTree", () => {
  it("compacts single-child chains and aggregates stats", () => {
    const rows = buildChangeSummaryTree([f("a/b/c/x.ts", 2, 1), f("a/b/c/y.ts", 3, 0)]);
    expect(rows.map((r) => [r.kind, r.kind === "folder" ? r.name : r.name, r.depth])).toEqual([
      ["folder", "a/b/c", 0],
      ["file", "x.ts", 1],
      ["file", "y.ts", 1],
    ]);
    expect(rows[0]).toMatchObject({
      id: "a/b/c",
      added: 5,
      removed: 1,
      fileCount: 2,
    });
  });

  it("sorts folders before files and keeps root files at depth 0", () => {
    const rows = buildChangeSummaryTree([f("z.ts"), f("src/a.ts"), f("src/lib/b.ts"), f("a.ts")]);
    expect(rows.map((r) => `${r.depth}:${r.kind === "folder" ? r.name : r.name}`)).toEqual([
      "0:src",
      "1:lib",
      "2:b.ts",
      "1:a.ts",
      "0:a.ts",
      "0:z.ts",
    ]);
  });

  it("omits descendants of collapsed folders but keeps the folder row", () => {
    const rows = buildChangeSummaryTree([f("src/a.ts"), f("src/lib/b.ts")], new Set(["src"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "folder", id: "src", fileCount: 2 });
  });

  it("normalizes Windows separators", () => {
    const rows = buildChangeSummaryTree([f("src\\a.ts"), f("src\\b.ts")]);
    expect(rows[0]).toMatchObject({ kind: "folder", name: "src" });
  });
});

describe("change summary tree view preference", () => {
  const makeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map,
    };
  };

  it("defaults to flat and round-trips", () => {
    const storage = makeStorage();
    expect(readChangeSummaryTreeViewPreference(storage)).toBe(false);
    persistChangeSummaryTreeViewPreference(true, storage);
    expect(storage.map.get(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY)).toBe("true");
    expect(readChangeSummaryTreeViewPreference(storage)).toBe(true);
    persistChangeSummaryTreeViewPreference(false, storage);
    expect(readChangeSummaryTreeViewPreference(storage)).toBe(false);
  });

  it("treats unknown values as flat", () => {
    const storage = makeStorage();
    storage.setItem(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY, "yes");
    expect(readChangeSummaryTreeViewPreference(storage)).toBe(false);
  });
});
