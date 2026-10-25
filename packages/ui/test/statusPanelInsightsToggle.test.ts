// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { GitRepositorySummary } from "@zcode/shared";
import type {
  SessionUsageState,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { LastTurnSectionModel } from "@/status-panel-insights/index.js";

vi.mock("@/ControlHintTooltip.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ControlHintTooltip.js")>()),
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeAgentService: { readSessionDebug: async () => null } }),
}));

vi.mock("@/GitActionMenu.js", () => ({
  GitActionMenu: () => createElement("div", { "data-testid": "mock-git-action-menu" }),
}));

vi.mock("@/GitBranchSwitcher.js", () => ({
  GitBranchSwitcher: () => createElement("div", { "data-testid": "mock-git-branch-switcher" }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, unknown>) =>
        values ? `${descriptor.id} ${Object.values(values).join("/")}` : descriptor.id,
      formatPlural: (descriptor: { id: string }, count: number) => `${descriptor.id}:${count}`,
    },
    locale: "en-US",
  }),
}));

function gitSummary(): GitRepositorySummary {
  return {
    workspacePath: "/repo",
    repoRoot: "/repo",
    workspaceInRepoPath: "",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: "origin/main",
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: true,
    isGitAvailable: true,
    isRepository: true,
  };
}

const USAGE: SessionUsageState = {
  contextWindow: {
    usedTokens: 593_000,
    maxTokens: 1_000_000,
    autoCompactThresholdTokens: 967_000,
    autoCompactThresholdAuthoritative: true,
  },
  cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
};

function lastTurn(overrides: Partial<LastTurnSectionModel> = {}): LastTurnSectionModel {
  return {
    target: { rowId: 7, entityId: "entity-7" },
    files: 1,
    additions: 4,
    deletions: 0,
    reverted: false,
    requestOptions: { cachePolicy: "terminal" },
    ...overrides,
  };
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
      writeCount: 2,
      toolNames: ["Edit"],
      patches: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+x"] }],
    },
  ],
};

const WITH_GIT = {
  workspacePath: "/repo",
  gitSummary: gitSummary(),
  gitDirtyFileCount: 2,
  gitWorktreeChangeSummary: { added: 12, removed: 3 },
  onRefreshGit: vi.fn(),
  parentSessionId: "session-1",
  summaryPanelVariantOverride: "panel" as const,
};

async function panel() {
  return (await import("@/v4/ConversationStatusPanel.js")).ConversationStatusPanel;
}

// Open state must survive re-renders while sibling sections change. The duplicate sibling key that broke this in
// the live app does not reproduce under jsdom; the desktop E2E (status-panel-last-turn) is the regression guard.
describe("ConversationStatusPanel insight section toggling", () => {
  it("keeps Last turn and Context open across re-renders", async () => {
    const ConversationStatusPanel = await panel();
    const props = {
      ...WITH_GIT,
      usage: USAGE,
      lastTurn: lastTurn(),
      fetchFileChanges: vi.fn(async () => MATH_RESULT),
    };
    // Usage arrives before the first editing turn, so Context mounts first and Last turn joins later.
    const view = render(createElement(ConversationStatusPanel, { ...props, lastTurn: null }));
    view.rerender(createElement(ConversationStatusPanel, props));
    await act(async () => {});
    const trigger = (section: string) =>
      view.container.querySelector<HTMLButtonElement>(
        `[data-status-section-trigger="${section}"]`,
      )!;

    expect(trigger("lastTurn").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger("lastTurn"));
    fireEvent.click(trigger("context"));
    await act(async () => {});
    // The live panel re-renders while sibling sections come and go (a todo appears mid-session).
    view.rerender(
      createElement(ConversationStatusPanel, {
        ...props,
        usage: { ...USAGE },
        plan: { updatedAt: 1, items: [{ id: "1", content: "Todo", status: "inProgress" }] },
      }),
    );
    await act(async () => {});
    view.rerender(createElement(ConversationStatusPanel, { ...props, usage: { ...USAGE } }));
    await act(async () => {});

    expect(trigger("lastTurn").getAttribute("aria-expanded")).toBe("true");
    expect(trigger("context").getAttribute("aria-expanded")).toBe("true");
    expect(
      view.container.querySelector('[data-status-panel-last-turn-file="src/math.js"]'),
    ).not.toBeNull();
  });
});
