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

vi.mock("@/components/IncognitoTaskMarker.js", () => ({
  IncognitoTaskMarker: ({ task }: { task: ZCodeTaskMeta }) =>
    task.incognito
      ? createElement("span", { "data-incognito-task-icon": "true" }, "incognito-marker")
      : null,
}));

function baseTask(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
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

function renderCard(task: ZCodeTaskMeta) {
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
            "taskList.untitled": "Untitled",
            "taskList.forkedUntitled": "Forked task",
          })[id] ?? id,
      },
    }),
  );
}

test("renders title, worktree branch with stats, and model details", () => {
  const html = renderCard(
    baseTask({
      executionWorktree: {
        path: "/repo-worktrees/zcode-lazy-kraken",
        branchName: "zcode/lazy-kraken",
      },
      model: "account:zai-individual-coding-plan/GLM-5.3",
      thoughtLevel: "xhigh",
      changeSummary: {
        fileCount: 2,
        added: 12,
        removed: 3,
        files: [{ path: "src/main.ts", added: 12, removed: 3 }],
      },
    }),
  );

  expect(html).toContain("Refactor hover card");
  expect(html).toContain('data-task-hover-status="completed"');
  expect(html).not.toContain(">Done<");
  expect(html).toContain("worktree-marker");
  expect(html).toContain("zcode/lazy-kraken");
  expect(html).toContain("+12");
  expect(html).toContain("-3");
  expect(html).toContain("<img");
  expect(html).not.toContain("lucide-cpu");
  expect(html).toContain("GLM-5.3");
  expect(html).not.toContain("account:zai-individual-coding-plan");
  expect(html).toContain("Extra High");
});

test("shows the incognito marker next to the title only for incognito sessions", () => {
  expect(renderCard(baseTask({ incognito: true }))).toContain("incognito-marker");
  expect(renderCard(baseTask())).not.toContain("incognito-marker");
});

test("shows change stats without a branch and falls back to Cpu for unknown providers", () => {
  const html = renderCard(
    baseTask({
      model: "weird-provider/X-model",
      changeSummary: {
        fileCount: 1,
        added: 5,
        removed: 1,
        files: [{ path: "src/a.ts", added: 5, removed: 1 }],
      },
    }),
  );

  expect(html).toContain("lucide-file-diff");
  expect(html).toContain("+5");
  expect(html).toContain("lucide-cpu");
  expect(html).toContain("X-model");
  expect(html).not.toContain("lucide-git-branch");
  expect(html).not.toContain("Merged");
});

test("empty task titles use the same localized fallback as sidebar rows", () => {
  expect(renderCard(baseTask({ title: "" }))).toContain("Untitled");
  expect(renderCard(baseTask({ title: "", forkedFromTaskId: "parent-task" }))).toContain(
    "Forked task",
  );
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
  // Runtime entries are per account; the icon must not depend on an exact base-id match.
  expect(providerBrandIconSrc(`${BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan}:0123456789abcdef`)).toBe(
    openAiIcon,
  );
});
