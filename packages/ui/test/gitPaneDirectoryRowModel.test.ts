import { describe, expect, it } from "vitest";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import {
  buildGitPaneDisplayRows,
  buildGitPaneRows,
  canShowGroupByDirectory,
  getChangeDirectory,
  getGitPaneRowIndexByPath,
} from "@/GitPane/directoryRowModel.js";

let nextId = 0;

function makeChange(
  overrides: Partial<GitPaneFileChange> & { workspaceRelativePath: string },
): GitPaneFileChange {
  nextId += 1;
  return {
    path: overrides.workspaceRelativePath,
    repoRelativePath: overrides.workspaceRelativePath,
    kind: "modified",
    section: "unstaged",
    added: 1,
    removed: 2,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    diff: null,
    ...overrides,
  };
}

function directories(rows: ReturnType<typeof buildGitPaneRows>): string[] {
  return rows.filter((row) => row.kind === "directory").map((row) => row.directory);
}

describe("buildGitPaneRows", () => {
  it("returns an empty array for an empty change list", () => {
    expect(buildGitPaneRows([])).toEqual([]);
  });

  it("groups consecutive same-directory files under one header", () => {
    const rows = buildGitPaneRows([
      makeChange({ workspaceRelativePath: "packages/ui/src/i18n/en-US.json" }),
      makeChange({ workspaceRelativePath: "packages/ui/src/i18n/uk-UA.json" }),
      makeChange({ workspaceRelativePath: "packages/ui/src/i18n/zh-CN.json" }),
    ]);

    expect(directories(rows)).toEqual(["packages/ui/src/i18n"]);
    const header = rows[0];
    expect(header).toMatchObject({ kind: "directory", fileCount: 3, additions: 3, deletions: 6 });
  });

  it("splits the same directory across a section boundary instead of reordering", () => {
    const rows = buildGitPaneRows([
      makeChange({ workspaceRelativePath: "packages/a/modified.ts", section: "unstaged" }),
      makeChange({ workspaceRelativePath: "packages/a/new.ts", section: "untracked" }),
    ]);

    expect(directories(rows)).toEqual(["packages/a", "packages/a"]);
    expect(rows.map((row) => (row.kind === "file" ? row.change.section : null))).toEqual([
      null,
      "unstaged",
      null,
      "untracked",
    ]);
    expect(rows[1]).toMatchObject({
      kind: "file",
      change: { workspaceRelativePath: "packages/a/modified.ts" },
    });
    expect(rows[3]).toMatchObject({
      kind: "file",
      change: { workspaceRelativePath: "packages/a/new.ts" },
    });
  });

  it("emits a header for a single-file run and covers root-level files", () => {
    const rows = buildGitPaneRows([
      makeChange({ workspaceRelativePath: "README.md" }),
      makeChange({ workspaceRelativePath: "apps/cli/main.ts" }),
    ]);

    expect(directories(rows)).toEqual(["", "apps/cli"]);
    expect(rows[0]).toMatchObject({
      kind: "directory",
      directory: "",
      fileCount: 1,
      additions: 1,
      deletions: 2,
    });
  });

  it("preserves the flat list order of file rows in grouped mode", () => {
    const changes = [
      makeChange({ workspaceRelativePath: "packages/shared/src/git.ts", section: "unstaged" }),
      makeChange({ workspaceRelativePath: "packages/ui/src/GitPane.tsx", section: "unstaged" }),
      makeChange({
        workspaceRelativePath: "packages/ui/src/i18n/en-US.json",
        section: "untracked",
      }),
    ];
    const rows = buildGitPaneRows(changes);
    const filePaths = rows
      .filter((row) => row.kind === "file")
      .map((row) => (row.kind === "file" ? row.change.workspaceRelativePath : ""));

    expect(filePaths).toEqual(changes.map((change) => change.workspaceRelativePath));
  });
});

describe("getGitPaneRowIndexByPath", () => {
  it("maps every file row to its virtualizer index, skipping directory headers", () => {
    const rows = buildGitPaneRows([
      makeChange({ workspaceRelativePath: "packages/a/one.ts" }),
      makeChange({ workspaceRelativePath: "packages/a/two.ts" }),
      makeChange({ workspaceRelativePath: "packages/b/three.ts" }),
    ]);

    const indexByPath = getGitPaneRowIndexByPath(rows);
    expect(indexByPath.get("packages/a/one.ts")).toBe(1);
    expect(indexByPath.get("packages/a/two.ts")).toBe(2);
    expect(indexByPath.get("packages/b/three.ts")).toBe(4);
    expect(indexByPath.size).toBe(3);
  });

  it("returns an empty map for an empty row list", () => {
    expect(getGitPaneRowIndexByPath([]).size).toBe(0);
  });
});

describe("getChangeDirectory", () => {
  it("returns an empty directory for root-level paths", () => {
    expect(getChangeDirectory(makeChange({ workspaceRelativePath: "README.md" }))).toBe("");
  });

  it("returns the parent directory for nested paths", () => {
    expect(
      getChangeDirectory(makeChange({ workspaceRelativePath: "packages/ui/src/GitPane.tsx" })),
    ).toBe("packages/ui/src");
  });
});

describe("buildGitPaneDisplayRows", () => {
  const sampleChanges = [
    makeChange({ workspaceRelativePath: "packages/a/one.ts", section: "unstaged" }),
    makeChange({ workspaceRelativePath: "packages/a/two.ts", section: "unstaged" }),
    makeChange({ workspaceRelativePath: "packages/a/new.ts", section: "untracked" }),
    makeChange({ workspaceRelativePath: "README.md", section: "untracked" }),
  ];

  it("returns exactly one file row per change, in input order, when grouping is off", () => {
    const rows = buildGitPaneDisplayRows(sampleChanges, false);

    expect(rows).toHaveLength(sampleChanges.length);
    expect(rows.every((row) => row.kind === "file")).toBe(true);
    expect(rows.map((row) => (row.kind === "file" ? row.change : null))).toEqual(sampleChanges);
  });

  it("returns the same rows as buildGitPaneRows when grouping is on", () => {
    expect(buildGitPaneDisplayRows(sampleChanges, true)).toEqual(buildGitPaneRows(sampleChanges));
  });

  it("returns an empty list for empty input in both modes", () => {
    expect(buildGitPaneDisplayRows([], false)).toEqual([]);
    expect(buildGitPaneDisplayRows([], true)).toEqual([]);
  });

  it("maps each change path to its file row in both modes", () => {
    for (const groupByDirectory of [false, true]) {
      const rows = buildGitPaneDisplayRows(sampleChanges, groupByDirectory);
      const indexByPath = getGitPaneRowIndexByPath(rows);

      expect(indexByPath.size).toBe(sampleChanges.length);
      for (const change of sampleChanges) {
        const index = indexByPath.get(change.path);
        expect(index).toBeDefined();
        expect(rows[index!]).toMatchObject({ kind: "file", change: { path: change.path } });
      }
    }
  });

  it("maps flat-mode paths to their change index (identity) so find scrolling is unchanged", () => {
    const indexByPath = getGitPaneRowIndexByPath(buildGitPaneDisplayRows(sampleChanges, false));

    sampleChanges.forEach((change, index) => {
      expect(indexByPath.get(change.path)).toBe(index);
    });
  });
});

describe("canShowGroupByDirectory", () => {
  it("shows the checkbox for a settled, non-empty list", () => {
    expect(canShowGroupByDirectory({ changeCount: 2, loading: false, error: null })).toBe(true);
  });

  it("hides the checkbox for an empty list", () => {
    expect(canShowGroupByDirectory({ changeCount: 0, loading: false, error: null })).toBe(false);
  });

  it("hides the checkbox while a refresh is loading, even with stale rows kept", () => {
    expect(canShowGroupByDirectory({ changeCount: 3, loading: true, error: null })).toBe(false);
  });

  it("hides the checkbox in the error state", () => {
    expect(canShowGroupByDirectory({ changeCount: 3, loading: false, error: "boom" })).toBe(false);
  });
});
