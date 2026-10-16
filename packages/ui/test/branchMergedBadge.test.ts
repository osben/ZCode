import { expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BranchMergedBadge } from "@/components/BranchMergedBadge.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        expect(id).toBe("taskList.branchMergedTag");
        return "Merged";
      },
    },
  }),
}));

test("merged badge shows GitMerge with an accessible label and no visible text", () => {
  const html = renderToStaticMarkup(createElement(BranchMergedBadge));

  expect(html).toContain("lucide-git-merge");
  expect(html).toContain('aria-label="Merged"');
  expect(html).toContain('title="Merged"');
  expect(html).not.toContain(">Merged<");
});

test("conversation rows hide the workspace-level merged badge and retain popup details", () => {
  const taskListItem = readFileSync(
    resolve(process.cwd(), "packages/ui/src/TaskListItem.tsx"),
    "utf8",
  );
  const groupedTaskRow = readFileSync(
    resolve(process.cwd(), "packages/ui/src/workspace-grouped-tasks/task-row.tsx"),
    "utf8",
  );

  for (const source of [taskListItem, groupedTaskRow]) {
    expect(source).not.toContain("BranchMergedBadge");
    expect(source).toContain("branchMergeStatus={branchMergeStatus}");
  }
});
