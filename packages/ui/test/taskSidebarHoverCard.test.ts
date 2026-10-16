import { expect, test, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILTIN_MODEL_PROVIDER_IDS, type ZCodeTaskMeta } from "@zcode/shared";
import { TaskSidebarHoverCard } from "@/components/TaskSidebarHoverCard.js";
import { providerBrandIconSrc } from "@/lib/oauthProviderIcon.js";

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/WorktreeTaskMarker.js", () => ({
  WorktreeTaskMarker: () =>
    createElement("span", { "data-worktree-task-icon": "true" }, "worktree-marker"),
}));

function baseTask(overrides: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: "hover-card-task",
    traceId: "hover-card-trace",
    title: "Refactor hover card",
    workspacePath: "/tmp/ZCode",
    createdAt: 1,
    updatedAt: Date.now(),
    mode: "default",
    ...overrides,
  };
}

function renderCard(
  task: ZCodeTaskMeta,
  extra?: Pick<Parameters<typeof TaskSidebarHoverCard>[0], "branchMergeStatus">,
) {
  return renderToStaticMarkup(
    createElement(TaskSidebarHoverCard, {
      task,
      attentionLabel: null,
      activity: { phase: "completedSuccess", lastActivityAt: Date.now(), hasBackgroundWork: false },
      intl: {
        formatMessage: ({ id }: { id: string }) =>
          ({
            "taskList.status.completed": "Done",
            "chat.toolbar.thoughtLevel.value.xhigh": "Extra High",
            "taskList.branchMergedTag": "Merged",
          })[id] ?? id,
      },
      ...extra,
    }),
  );
}

test("renders title line, merged branch line with stats, and model line", () => {
  const task = baseTask({
    model: "account:zai-individual-coding-plan/GLM-5.3",
    thoughtLevel: "xhigh",
    changeSummary: {
      fileCount: 2,
      added: 12,
      removed: 3,
      files: [{ path: "src/main.ts", added: 12, removed: 3 }],
    },
  });
  const html = renderCard(task, {
    branchMergeStatus: {
      state: "merged",
      baseRef: "origin/main",
      headRef: "feature/hover-card",
      lastCommitAt: null,
    },
  });

  // Line 1: the card now carries the title; the status chip is gone (row owns run state).
  expect(html).toContain("Refactor hover card");
  expect(html).toContain('data-task-hover-status="completed"');
  expect(html).not.toContain(">Done<");
  // Line 2: merged tag + stats share the branch line; the raw branch name stays hidden.
  expect(html).toContain("lucide-git-merge");
  expect(html).toContain("Merged");
  expect(html).toContain("+12");
  expect(html).toContain("-3");
  expect(html).not.toContain("origin/main");
  expect(html).not.toContain("feature/hover-card");
  // Line 3: the built-in Z.ai account provider renders its brand asset; model + effort stay.
  expect(html).toContain("<img");
  expect(html).not.toContain("lucide-cpu");
  expect(html).toContain("GLM-5.3");
  expect(html).not.toContain("account:zai-individual-coding-plan");
  expect(html).toContain("Extra High");
});

test("worktree branch wins over merge-status head and the worktree marker renders", () => {
  const task = baseTask({
    executionWorktree: {
      path: "/repo-worktrees/zcode-lazy-kraken",
      branchName: "zcode/lazy-kraken",
    },
    model: "zai/GLM-5.3",
  });
  const html = renderCard(task, {
    branchMergeStatus: {
      state: "not_merged",
      baseRef: "origin/main",
      headRef: "feature/other",
      lastCommitAt: null,
    },
  });

  expect(html).toContain("worktree-marker");
  expect(html).toContain("zcode/lazy-kraken");
  expect(html).not.toContain("feature/other");
  expect(html).toContain("lucide-git-branch");
  // Known provider id renders the brand asset (vite inlines the svg as a data URI) instead of Cpu.
  expect(html).toContain("<img");
  expect(html).toContain("data:image/svg+xml");
  expect(html).not.toContain("lucide-cpu");
});

test("stats survive without any branch source; unknown provider falls back to Cpu", () => {
  const task = baseTask({
    model: "weird-provider/X-model",
    changeSummary: {
      fileCount: 1,
      added: 5,
      removed: 1,
      files: [{ path: "src/a.ts", added: 5, removed: 1 }],
    },
  });
  const html = renderCard(task);

  expect(html).toContain("lucide-file-diff");
  expect(html).toContain("+5");
  expect(html).toContain("lucide-cpu");
  expect(html).toContain("X-model");
});

test("canonical built-in account provider IDs resolve to their brand icons", () => {
  const zaiIcon = providerBrandIconSrc("zai");
  const bigModelIcon = providerBrandIconSrc("bigmodel");
  const openAiIcon = providerBrandIconSrc("openai");

  for (const providerId of [
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  ]) {
    expect(providerBrandIconSrc(providerId)).toBe(zaiIcon);
  }
  for (const providerId of [
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
  ]) {
    expect(providerBrandIconSrc(providerId)).toBe(bigModelIcon);
  }
  expect(providerBrandIconSrc(BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan)).toBe(openAiIcon);
});
