import { expect, test, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskSidebarHoverCard } from "@/components/TaskSidebarHoverCard.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) =>
        ({
          "taskList.status.completed": "Done",
          "chat.toolbar.thoughtLevel.value.xhigh": "Extra High",
          "taskList.branchMergedTag": "Merged",
          "taskList.justNow": "now",
        })[id] ?? id,
    },
  }),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

test("renders available task hover details without repeating the title", () => {
  const task: ZCodeTaskMeta = {
    taskId: "hover-card-task",
    traceId: "hover-card-trace",
    title: "Title stays in the row",
    workspacePath: "/tmp/ZCode",
    createdAt: 1,
    updatedAt: Date.now(),
    mode: "default",
    model: "account:zai-individual-coding-plan/GLM-5.3",
    thoughtLevel: "xhigh",
    changeSummary: {
      fileCount: 2,
      added: 12,
      removed: 3,
      files: [{ path: "src/main.ts", added: 12, removed: 3 }],
    },
  };
  const html = renderToStaticMarkup(
    createElement(TaskSidebarHoverCard, {
      task,
      workspaceLabel: "ZCode",
      attentionLabel: null,
      activity: { phase: "completedSuccess", lastActivityAt: Date.now(), hasBackgroundWork: false },
      branchMergeStatus: {
        state: "merged",
        baseRef: "origin/main",
        headRef: "feature/hover-card",
        lastCommitAt: null,
      },
    }),
  );

  expect(html).toContain('data-task-hover-status="completed"');
  expect(html).toContain("ZCode");
  expect(html).toContain("lucide-git-merge");
  expect(html).toContain("Merged");
  expect(html).not.toContain("origin/main");
  expect(html).not.toContain("feature/hover-card");
  expect(html).toContain("GLM-5.3");
  expect(html).not.toContain("account:zai-individual-coding-plan");
  expect(html).toContain("Extra High");
  expect(html).toContain("+12");
  expect(html).toContain("-3");
  expect(html).not.toContain("Title stays in the row");
});
