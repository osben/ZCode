import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PullRequestStatusIcon,
  formatPullRequestHealthText,
  pullRequestHealthDotClass,
  pullRequestStageMessageId,
} from "../src/components/PullRequestStatusIcon.js";

test("renders the lifecycle glyph with the stage color for every stage", () => {
  const cases = [
    ["draft", "text-pr-draft", "lucide-git-pull-request-draft"],
    ["open", "text-pr-open", "lucide-git-pull-request"],
    ["merged", "text-pr-merged", "lucide-git-merge"],
    ["closed", "text-pr-closed", "lucide-git-pull-request-closed"],
  ] as const;
  for (const [stage, colorClass, glyph] of cases) {
    const html = renderToStaticMarkup(createElement(PullRequestStatusIcon, { stage }));
    expect(html).toContain(glyph);
    expect(html).toContain(colorClass);
    expect(html).not.toContain("rounded-full", "no health dot without a variant");
  }
});

test("row dot: destructive for failing/conflict, warning for optional/running, none for passing", () => {
  const dotFor = (health: Parameters<typeof pullRequestHealthDotClass>[0]) =>
    renderToStaticMarkup(
      createElement(PullRequestStatusIcon, { stage: "open", health, dotVariant: "row" }),
    );
  expect(dotFor("failing")).toContain("bg-destructive");
  expect(dotFor("conflict")).toContain("bg-destructive");
  expect(dotFor("optional_failing")).toContain("bg-warning");
  expect(dotFor("running")).toContain("bg-warning");
  expect(dotFor("passing")).not.toContain("rounded-full");
  expect(dotFor("none")).not.toContain("rounded-full");
});

test("detail dot keeps the success dot for passing", () => {
  const html = renderToStaticMarkup(
    createElement(PullRequestStatusIcon, {
      stage: "open",
      health: "passing",
      dotVariant: "detail",
    }),
  );
  expect(html).toContain("bg-success");
});

test("label becomes the accessible image label and tooltip", () => {
  const html = renderToStaticMarkup(
    createElement(PullRequestStatusIcon, {
      stage: "draft",
      label: "PR #7 · Draft",
    }),
  );
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="PR #7 · Draft"');
  expect(html).toContain('title="PR #7 · Draft"');
});

const FAKE_INTL = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) =>
    values ? `${descriptor.id}:${Object.values(values).join(",")}` : descriptor.id,
};

test("health text maps health to message ids with counts", () => {
  expect(formatPullRequestHealthText(FAKE_INTL, "failing", 2)).toBe("pullRequest.checksFailing:2");
  expect(formatPullRequestHealthText(FAKE_INTL, "optional_failing", 1)).toBe(
    "pullRequest.checksOptionalFailing:1",
  );
  expect(formatPullRequestHealthText(FAKE_INTL, "running", 0)).toBe("pullRequest.checksRunning");
  expect(formatPullRequestHealthText(FAKE_INTL, "conflict", 0)).toBe("pullRequest.conflict");
  expect(formatPullRequestHealthText(FAKE_INTL, "passing", 0)).toBe(null);
  expect(formatPullRequestHealthText(FAKE_INTL, "none", 0)).toBe(null);
});

test("stage message ids cover the four stages", () => {
  expect(pullRequestStageMessageId("draft")).toBe("pullRequest.stageDraft");
  expect(pullRequestStageMessageId("open")).toBe("pullRequest.stageOpen");
  expect(pullRequestStageMessageId("merged")).toBe("pullRequest.stageMerged");
  expect(pullRequestStageMessageId("closed")).toBe("pullRequest.stageClosed");
});
