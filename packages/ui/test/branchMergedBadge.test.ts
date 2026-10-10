import { expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
