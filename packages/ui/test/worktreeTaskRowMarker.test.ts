import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { WorktreeTaskMarker } from "@/components/WorktreeTaskMarker.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        [id, ...Object.values(values ?? {})].join(" · "),
    },
  }),
}));

const markerSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/components/WorktreeTaskMarker.tsx"),
  "utf8",
);

describe("shared worktree task marker", () => {
  it("renders the Split glyph rotated 90°, quiet unless missing (specs/worktree-icon-visibility.md)", () => {
    expect(markerSource).toContain("<Split");
    expect(markerSource).toContain('"size-3.5 shrink-0 rotate-90"');
    expect(markerSource).toContain('isMissing && "text-destructive"');
    // The sidebar marker carries no color highlight: the violet token is not used here.
    expect(markerSource).not.toContain("text-worktree-task");
    expect(markerSource).toContain('data-worktree-task-icon="true"');
  });

  it("tooltips name the branch and the worktree directory; missing keeps its own label", () => {
    expect(markerSource).toContain("worktreeDirectoryNameOf");
    expect(markerSource).toContain("taskList.worktreeTaskLabelMissing");
    expect(markerSource).toContain("taskList.worktreeTaskLabelNoBranch");
    expect(markerSource).toContain("taskList.worktreeTaskLabel");
  });

  it("renders in both grouped task-row chains and both active-task list branches", () => {
    const taskRow = readFileSync(
      resolve(process.cwd(), "packages/ui/src/workspace-grouped-tasks/task-row.tsx"),
      "utf8",
    );
    const taskListItem = readFileSync(
      resolve(process.cwd(), "packages/ui/src/TaskListItem.tsx"),
      "utf8",
    );
    expect(taskRow.match(/<WorktreeTaskMarker task=\{task\} \/>/gu)).toHaveLength(2);
    expect(taskListItem.match(/<WorktreeTaskMarker task=\{task\} \/>/gu)).toHaveLength(2);
  });

  it("declares the worktree marker token in every theme block that declares idle-task", () => {
    const css = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    expect(css.match(/--color-worktree-task:/gu)).toHaveLength(4);
    expect(css.match(/--color-idle-task:/gu)).toHaveLength(4);
  });
});

it("keeps the branch and directory in a missing worktree's error disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(WorktreeTaskMarker, {
      task: {
        executionWorktree: {
          path: "/repo-worktrees/zcode-lazy-kraken",
          branchName: "zcode/lazy-kraken",
        },
        executionWorktreeMissing: true,
      } as ZCodeTaskMeta,
    }),
  );
  expect(html).toContain("taskList.worktreeTaskLabelMissing");
  expect(html).toContain("zcode/lazy-kraken");
  expect(html).toContain("zcode-lazy-kraken");
  expect(html).toContain("text-destructive");
});
