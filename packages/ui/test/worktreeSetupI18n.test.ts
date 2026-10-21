import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en-US.js";
import uk from "@/i18n/locales/uk-UA.js";
import zh from "@/i18n/locales/zh-CN.js";

// BUG-GWT-004 (docs/testing/git-worktree-qa/bugs/BUG-GWT-004.md): the worktree setup steps card
// rendered raw i18n ids ("worktreeSetup.stepFailed", "worktreeSetup.retry", ...) in the failure
// and recovery UI because ConversationWorktreeSetupSteps.tsx references catalog entries that no
// locale defines. createIntl.formatMessage falls back to the raw id when the fallback catalog
// (en-US) lacks the key, so a missing translation leaks the id straight into the UI. Guard that
// every intl.formatMessage id used by the component exists in all shipped locale catalogs.

// The created notice renders its own worktreeSetup ids, so both components are scanned.
const COMPONENT_PATHS = [
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/v4/ConversationWorktreeSetupSteps.tsx"),
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../src/v4/ConversationWorktreeCreatedNotice.tsx",
  ),
];

const componentSource = COMPONENT_PATHS.map((path) => readFileSync(path, "utf8")).join("\n");

// Every literal formatMessage({ id: "..." }) call site in the component. Dynamic helpers that
// forward ids from other modules (reconcile.*) are owned by those modules and verified there.
const usedIds = [
  ...new Set(
    [...componentSource.matchAll(/formatMessage\(\s*\{\s*id:\s*"([^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  ),
].sort();

describe("ConversationWorktreeSetupSteps i18n coverage", () => {
  it("collects formatMessage ids from the component source", () => {
    // Anchors the extraction: if this breaks, the coverage assertion below
    // would pass vacuously with an empty id list.
    expect(usedIds.length).toBeGreaterThan(0);
    expect(usedIds).toContain("worktreeSetup.newTaskInWorktree");
  });

  // BUG-GWT-004 regression guard: a missing id renders as a raw key in the UI, so every id the
  // steps card uses must exist in all locale catalogs.
  it("BUG-GWT-004: every worktreeSetup id used by the steps card exists in locale catalogs", () => {
    const catalogs = { "en-US": en, "zh-CN": zh, "uk-UA": uk } as const;
    const missingByLocale = Object.fromEntries(
      Object.entries(catalogs).map(([name, catalog]) => [
        name,
        usedIds.filter((id) => typeof catalog[id] !== "string"),
      ]),
    );
    expect(missingByLocale).toEqual({ "en-US": [], "zh-CN": [], "uk-UA": [] });
  });
});
