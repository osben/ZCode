import { expect, it, vi } from "vitest";
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
