import { describe, expect, it } from "vitest";
import type {
  ConversationRow,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildLastTurnGitDataset,
  selectLastFileChangeTurn,
  withLastTurnDataset,
} from "../src/review-last-turn/index.js";
import { formatReadonlyDiffPatch } from "../src/review-last-turn/readonlyDiffPatch.js";
import { getGitPaneDiffPreviewPlan } from "../src/GitPane/helpers.js";
import type { GitPaneRepositoryState } from "../src/hooks/useGitRepository.js";

function turnHeader(
  rowId: number,
  fileChanges?: { files: number; additions: number; deletions: number },
): ConversationRow {
  return {
    kind: "turnHeader",
    rowId,
    turnId: `turn-${rowId}`,
    entityId: `entity-${rowId}`,
    createdAt: "2026-10-23T16:00:00.000Z",
    createdAtSeq: rowId,
    origin: "userInput",
    state: "completedSuccess",
    startedAt: "2026-10-23T16:00:00.000Z",
    ...(fileChanges ? { fileChanges } : {}),
  } as ConversationRow;
}

const MATH_RESULT: V4ConversationFileChangesResult = {
  files: 1,
  additions: 4,
  deletions: 0,
  items: [
    {
      path: "/repo/src/math.js",
      additions: 4,
      deletions: 0,
      writeCount: 1,
      toolNames: ["Edit"],
      patches: [
        {
          oldStart: 3,
          oldLines: 0,
          newStart: 4,
          newLines: 4,
          lines: ["+export function square(x) {", "+  return x * x;", "+}", "+"],
        },
      ],
    },
  ],
};

describe("selectLastFileChangeTurn (ISSUE-056)", () => {
  it("picks the latest turn that changed files, skipping later turns without changes", () => {
    const rows = [
      turnHeader(1, { files: 2, additions: 1, deletions: 1 }),
      turnHeader(5, { files: 1, additions: 4, deletions: 0 }),
      turnHeader(9),
      turnHeader(12, { files: 0, additions: 0, deletions: 0 }),
    ];
    expect(selectLastFileChangeTurn(rows)?.rowId).toBe(5);
  });

  it("returns null when no turn changed files", () => {
    expect(selectLastFileChangeTurn([turnHeader(1), turnHeader(2)])).toBeNull();
    expect(selectLastFileChangeTurn([])).toBeNull();
  });

  it("ignores turns without a persisted entity id (no query target)", () => {
    const header = turnHeader(3, { files: 1, additions: 1, deletions: 0 });
    delete (header as { entityId?: string }).entityId;
    expect(selectLastFileChangeTurn([header])).toBeNull();
  });
});

describe("buildLastTurnGitDataset (ISSUE-056)", () => {
  it("maps turn file changes to a read-only last-turn dataset with the turn patch", () => {
    const dataset = buildLastTurnGitDataset({ workspacePath: "/repo", result: MATH_RESULT });
    expect(dataset.id).toBe("last-turn");
    expect(dataset.readonly).toBe(true);
    expect(dataset.sections).toHaveLength(1);
    const [change] = dataset.sections[0]!.changes;
    expect(change).toMatchObject({
      path: "/repo/src/math.js",
      workspaceRelativePath: "src/math.js",
      repoRelativePath: "src/math.js",
      section: "last-turn",
      kind: "modified",
      added: 4,
      removed: 0,
      isStaged: false,
    });
    expect(change!.diff).toEqual({
      path: "/repo/src/math.js",
      availability: "patch",
      patch: formatReadonlyDiffPatch("src/math.js", MATH_RESULT.items[0]!.patches),
      beforeContent: null,
      afterContent: null,
      summary: null,
    });
    expect(change!.diff!.patch!.split("\n").slice(0, 3)).toEqual([
      "--- a/src/math.js",
      "+++ b/src/math.js",
      "@@ -3,0 +4,4 @@",
    ]);
    // Patch-only diffs (no before/after content) take GitPane's PatchDiff route, not the rich diff.
    expect(getGitPaneDiffPreviewPlan(change!.diff).kind).toBe("patch");
  });

  it("marks created and deleted files from their hunk ranges", () => {
    const dataset = buildLastTurnGitDataset({
      workspacePath: "/repo",
      result: {
        files: 2,
        additions: 1,
        deletions: 1,
        items: [
          {
            path: "/repo/new.txt",
            additions: 1,
            deletions: 0,
            writeCount: 1,
            toolNames: ["Write"],
            patches: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+qa"] }],
          },
          {
            path: "/repo/old.txt",
            additions: 0,
            deletions: 1,
            writeCount: 1,
            toolNames: ["Bash"],
            patches: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-qa"] }],
          },
        ],
      },
    });
    expect(dataset.sections[0]!.changes.map((change) => change.kind)).toEqual(["added", "deleted"]);
  });

  it("returns an empty dataset without a result, so the existing empty state shows", () => {
    expect(buildLastTurnGitDataset({ workspacePath: "/repo", result: null }).sections).toEqual([]);
    expect(
      buildLastTurnGitDataset({
        workspacePath: "/repo",
        result: { files: 0, additions: 0, deletions: 0, items: [] },
      }).sections,
    ).toEqual([]);
  });
});

describe("withLastTurnDataset (ISSUE-056)", () => {
  const baseState = {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    sourceOptions: [
      { id: "unstaged", count: 1, readonly: false, disabled: false },
      { id: "last-turn", count: 0, readonly: true, disabled: false },
    ],
    datasets: {
      unstaged: { id: "unstaged", readonly: false, sections: [] },
      staged: { id: "staged", readonly: false, sections: [] },
      branch: { id: "branch", readonly: true, sections: [] },
      "last-turn": { id: "last-turn", readonly: true, sections: [] },
    },
  } as unknown as GitPaneRepositoryState;

  it("replaces only the last-turn dataset and its option count", () => {
    const dataset = buildLastTurnGitDataset({ workspacePath: "/repo", result: MATH_RESULT });
    const next = withLastTurnDataset(baseState, { dataset, count: 1 });
    expect(next.datasets["last-turn"]).toBe(dataset);
    expect(next.datasets.unstaged).toBe(baseState.datasets.unstaged);
    expect(next.sourceOptions.find((option) => option.id === "last-turn")?.count).toBe(1);
    expect(next.sourceOptions.find((option) => option.id === "unstaged")?.count).toBe(1);
  });

  it("keeps the same state object when there is nothing to show", () => {
    expect(withLastTurnDataset(baseState, null)).toBe(baseState);
  });
});
