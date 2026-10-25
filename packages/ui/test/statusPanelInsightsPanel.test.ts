// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

// Content always renders so the bodies mount without driving the Radix animation.
vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: ({
    children,
    defaultOpen: _defaultOpen,
    onOpenChange: _onOpenChange,
    open: _open,
    ...props
  }: {
    children: ReactNode;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    [key: string]: unknown;
  }) => createElement("div", { "data-slot": "collapsible", ...props }, children),
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => children,
  CollapsibleContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-slot": "collapsible-content" }, children),
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

describe("ConversationStatusPanel Context and Last turn sections", () => {
  it("never mounts the panel on their own", async () => {
    const ConversationStatusPanel = await panel();
    const html = renderToStaticMarkup(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        parentSessionId: "session-1",
        usage: USAGE,
        lastTurn: lastTurn(),
      }),
    );
    expect(html).toBe("");
  });

  it("places Last turn after Git Tools and Context last, with header summaries", async () => {
    const ConversationStatusPanel = await panel();
    const html = renderToStaticMarkup(
      createElement(ConversationStatusPanel, {
        ...WITH_GIT,
        plan: { updatedAt: 1, items: [{ id: "1", content: "Todo", status: "inProgress" }] },
        usage: USAGE,
        lastTurn: lastTurn({ reverted: true }),
      }),
    );
    const indexes = ["environment", "lastTurn", "plan", "context"].map((section) =>
      html.indexOf(`data-status-section="${section}"`),
    );
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    expect(html).toContain("chat.statusPanel.lastTurnFiles:1");
    expect(html).toContain("chat.statusPanel.lastTurnReverted");
    expect(html).toContain('data-status-panel-context-percent="normal"');
    expect(html).toContain("59%");
    expect(html).toContain('data-status-panel-context-threshold="true"');
  });

  it("omits Context without a reported window and Last turn without a session", async () => {
    const ConversationStatusPanel = await panel();
    const html = renderToStaticMarkup(
      createElement(ConversationStatusPanel, {
        ...WITH_GIT,
        parentSessionId: undefined,
        usage: { ...USAGE, contextWindow: null },
        lastTurn: lastTurn(),
      }),
    );
    expect(html).toContain('data-status-section="environment"');
    expect(html).not.toContain('data-status-section="lastTurn"');
    expect(html).not.toContain('data-status-section="context"');
  });

  it("reads the turn's files, opens a patch and opens Review on the last-turn source", async () => {
    const ConversationStatusPanel = await panel();
    const fetchFileChanges = vi.fn(async () => MATH_RESULT);
    const onOpenCodeViewer = vi.fn();
    const onOpenGitReview = vi.fn();
    const view = render(
      createElement(ConversationStatusPanel, {
        ...WITH_GIT,
        lastTurn: lastTurn(),
        fetchFileChanges,
        onOpenCodeViewer,
        onOpenGitReview,
        workspaceIdentity: "ws-1",
      }),
    );
    await act(async () => {});

    expect(fetchFileChanges).toHaveBeenCalledWith(
      { rowId: 7, entityId: "entity-7" },
      { cachePolicy: "terminal" },
    );
    const row = view.container.querySelector('[data-status-panel-last-turn-file="src/math.js"]');
    expect(row?.textContent).toContain("×2");
    fireEvent.click(row!);
    expect(onOpenCodeViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch",
        title: "src/math.js",
        path: "/repo/src/math.js",
        workspaceIdentity: "ws-1",
      }),
    );

    fireEvent.click(view.container.querySelector('[data-status-panel-last-turn-review="true"]')!);
    expect(onOpenGitReview).toHaveBeenCalledWith("last-turn");
  });

  it("drops a detail response that belongs to an older turn aggregate", async () => {
    const ConversationStatusPanel = await panel();
    let resolveFirst: (result: V4ConversationFileChangesResult) => void = () => {};
    const fetchFileChanges = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<V4ConversationFileChangesResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => new Promise<V4ConversationFileChangesResult>(() => {}));
    const view = render(
      createElement(ConversationStatusPanel, {
        ...WITH_GIT,
        lastTurn: lastTurn({ requestOptions: { cachePolicy: "in-flight" } }),
        fetchFileChanges,
      }),
    );
    view.rerender(
      createElement(ConversationStatusPanel, {
        ...WITH_GIT,
        lastTurn: lastTurn({
          files: 2,
          additions: 9,
          requestOptions: { cachePolicy: "in-flight" },
        }),
        fetchFileChanges,
      }),
    );
    await act(async () => {
      resolveFirst(MATH_RESULT);
    });

    expect(fetchFileChanges).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("[data-status-panel-last-turn-file]")).toBeNull();
  });
});
