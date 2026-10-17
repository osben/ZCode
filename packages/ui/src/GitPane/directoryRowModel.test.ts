import { describe, expect, it } from "vitest";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import {
  buildGitPaneRows,
  getChangeDirectory,
  getGitPaneRowIndexByPath,
} from "./directoryRowModel.js";

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
