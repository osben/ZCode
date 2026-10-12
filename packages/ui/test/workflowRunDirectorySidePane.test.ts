// @vitest-environment jsdom

// The dwf run directory page (docs/dynamic-workflow/presentation.md "Other places a run appears"):
// task island footer row → (this file) → the existing `workflow-run` detail page, isomorphic to the subagent's
// three-step shape.
//
// The bucketing/pruning/truncation rules are exhaustively covered in workflowRunDirectoryModel.test.ts, and the
// fetch/retry semantics in
// useWorkflowRunJournalSummaries.test.ts; this file only pins "those results really reached the DOM",
// what a row click emits, and that the three empty states are distinguishable on screen.
import { createElement, useEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunDirectorySidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

// Lease and projection: the page uses the projection **only as a freshness trigger** (rows still render only
// journal summaries).
// layer must be a stable reference — the lease effect depends on it, and a fresh object every render would
// become an infinite loop.
const release = vi.fn();
const acquire = vi.fn(() => ({ release }));
const layer = { acquire };

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => ({ layer }),
}));

let snapshot: { workflowRuns?: { revision: number; runs: unknown[] } } | null = null;
// The projection stub must **really push**: the content component under test is memoized, so a rerender with
// unchanged props won't re-render it at all.
// A stub reading a module variable would therefore fake "the projection updated but the UI didn't react" —
// exactly the shape of the bug this round fixes, and the stub must not manufacture it itself. A minimal
// subscription is used here, matching production useConversationProjection's semantics.
const projectionListeners = new Set<() => void>();
function pushProjection(next: typeof snapshot) {
  snapshot = next;
  for (const listener of projectionListeners) listener();
}
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => {
    const [, forceRender] = useState(0);
    useEffect(() => {
      const listener = () => forceRender((generation) => generation + 1);
      projectionListeners.add(listener);
      return () => {
        projectionListeners.delete(listener);
      };
    }, []);
    return { snapshot };
  },
}));

// The fetch hook is stubbed: its own behavior (capability-absent terminal state, live retry, refreshKey) has
// dedicated cases;
// what's pinned here is **what the page asks it for** (limit must be the same depth as the task island count,
// otherwise the two places' scopes diverge;
// refreshKey must really be wired, otherwise finished runs stay "running" forever) and what each of the three
// returns looks like.
let summaries: readonly V4ConversationWorkflowRunSummary[] | null = null;
let optionsSeen:
  | { sessionId: string | null; live: boolean; limit?: number; refreshKey?: number | string }
  | undefined;
const refreshKeysSeen: (number | string | undefined)[] = [];
vi.mock("@/hooks/useWorkflowRunJournalSummaries.js", () => ({
  useWorkflowRunJournalSummaries: (options: {
    sessionId: string | null;
    live: boolean;
    limit?: number;
    refreshKey?: number | string;
  }) => {
    optionsSeen = options;
    if (refreshKeysSeen.at(-1) !== options.refreshKey) refreshKeysSeen.push(options.refreshKey);
    return summaries;
  },
}));

// eslint-disable-next-line import/first -- the component under test must be imported after all mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowRunDirectorySidePane } from "@/app-shell/WorkflowRunDirectorySidePane.js";
// eslint-disable-next-line import/first
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";

const tab: WorkflowRunDirectorySidePaneTab = {
  id: "workflow-directory:%2Fworkspace:parent-a",
  type: "workflow-directory",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent-a",
};

const onOpenWorkflowRun = vi.fn();

function summary(
  overrides: Partial<V4ConversationWorkflowRunSummary> &
    Pick<V4ConversationWorkflowRunSummary, "runId">,
): V4ConversationWorkflowRunSummary {
  return {
    toolCallId: `call-${overrides.runId}`,
    status: "completed",
    resumable: false,
    ...overrides,
  };
}

/** The trigger-side input: a run in the projection (only identity and status matter for the key). */
function projectionRun(runId: string, status: "running" | "pending" | "completed" | "errored") {
  return {
    runId,
    toolCallId: `call-${runId}`,
    status,
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
  };
}

function renderPane(locale: "en-US" | "zh-CN" = "en-US") {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunDirectorySidePane, { tab, onOpenWorkflowRun }),
    ),
  );
}

function rows(pane: ReturnType<typeof renderPane>, section: "running" | "ended") {
  return [
    ...pane.container.querySelectorAll(
      `[data-workflow-directory-section="${section}"] [data-run-id]`,
    ),
  ];
}

beforeEach(() => {
  summaries = null;
  optionsSeen = undefined;
  refreshKeysSeen.length = 0;
  snapshot = null;
  acquire.mockClear();
  release.mockClear();
  onOpenWorkflowRun.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("WorkflowRunDirectorySidePane", () => {
  it("按会话取一页 journal，深度与任务岛计数同一个常量（口径分叉就是「岛说 5、页面 4」）", () => {
    summaries = [];
    renderPane();

    expect(optionsSeen?.sessionId).toBe("parent-a");
    expect(optionsSeen?.live).toBe(true);
    expect(optionsSeen?.limit).toBe(WORKFLOW_RUN_DIRECTORY_LIMIT);
  });

  // ── Auto-refresh (measured bug: a finished run doesn't move itself to "ended") ──
  //
  // The broken shape is "the page has no signal at all": the hook settles on its first answer and that page
  // freezes for the pane's remaining life.
  // So what's pinned here is **the signal being wired**, not any specific key value.

  it("把投影派生出的 refreshKey 交给取数 hook（缺了它那一页会永远冻住）", () => {
    summaries = [];
    snapshot = { workflowRuns: { revision: 1, runs: [projectionRun("r-1", "running")] } };
    renderPane();

    expect(optionsSeen?.refreshKey).toBe(
      workflowRunDirectoryRefreshKey([projectionRun("r-1", "running")] as never),
    );
  });

  it("run 跑完时 refreshKey 变化 → hook 重取 → 那一行自己挪到「已结束」", () => {
    summaries = [summary({ runId: "r-1", status: "running" })];
    snapshot = { workflowRuns: { revision: 1, runs: [projectionRun("r-1", "running")] } };
    const pane = renderPane();
    expect(rows(pane, "running").map((row) => row.getAttribute("data-run-id"))).toEqual(["r-1"]);
    const keyWhileRunning = optionsSeen?.refreshKey;

    // Engine settles → projection flips to terminal; the journal's next answer then moves this run to ended.
    act(() => {
      summaries = [summary({ runId: "r-1", status: "completed" })];
      pushProjection({ workflowRuns: { revision: 2, runs: [projectionRun("r-1", "completed")] } });
    });

    expect(optionsSeen?.refreshKey).not.toBe(keyWhileRunning);
    expect(rows(pane, "running")).toEqual([]);
    expect(rows(pane, "ended").map((row) => row.getAttribute("data-run-id"))).toEqual(["r-1"]);
  });

  it("节点级进度不抬 refreshKey：开着的页面不会因为引擎事件反复读 journal", () => {
    summaries = [summary({ runId: "r-1", status: "running" })];
    snapshot = { workflowRuns: { revision: 1, runs: [projectionRun("r-1", "running")] } };
    renderPane();

    // The same run still running, just one more node settled (revision raised too) — the key must not move.
    act(() => {
      pushProjection({
        workflowRuns: {
          revision: 2,
          runs: [
            {
              ...projectionRun("r-1", "running"),
              nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }],
              lastEventSequence: 7,
            },
          ],
        },
      });
    });

    expect(refreshKeysSeen).toHaveLength(1);
  });

  it("按会话取租约，卸载时放掉（投影只当触发器，但租约照样是租约）", () => {
    summaries = [];
    const pane = renderPane();

    expect(acquire).toHaveBeenCalledWith("parent-a");
    expect(release).not.toHaveBeenCalled();
    pane.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("两段各自渲染并带计数：运行中与已结束", () => {
    summaries = [
      summary({ runId: "r-run", status: "running", label: "find-flaky-tests" }),
      summary({ runId: "r-done", status: "completed", label: "review-changes" }),
      summary({ runId: "r-cancel", status: "stopped", label: "migrate-imports" }),
    ];
    const pane = renderPane();

    expect(rows(pane, "running").map((row) => row.getAttribute("data-run-id"))).toEqual(["r-run"]);
    expect(rows(pane, "ended").map((row) => row.getAttribute("data-run-id"))).toEqual([
      "r-done",
      "r-cancel",
    ]);
    expect(pane.getByTestId("workflow-run-directory-running-count").textContent).toContain("1");
    expect(pane.getByTestId("workflow-run-directory-ended-count").textContent).toContain("2");
    expect(pane.getByText("find-flaky-tests")).toBeTruthy();
  });

  it("行点击开详情页，参数带全（runId + toolCallId + 展示名做标题兜底）", () => {
    summaries = [summary({ runId: "r-done", label: "review-changes" })];
    const pane = renderPane();

    fireEvent.click(pane.container.querySelector("[data-run-id='r-done']") as Element);

    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "r-done",
      toolCallId: "call-r-done",
      workflowName: "review-changes",
    });
  });

  it("没有 label 的 run 用既有的兜底名，绝不显示裸 runId", () => {
    summaries = [summary({ runId: "dwfrun-8f21" })];
    const pane = renderPane();

    expect(pane.queryByText("dwfrun-8f21")).toBeNull();
    expect(pane.getByText("Workflow script")).toBeTruthy();
  });

  it("状态词复用既有词汇表；stopped 行跟原因词，errored 行跟 failureCode（决策 15）", () => {
    summaries = [
      summary({
        runId: "r-stop",
        status: "stopped",
        stopReason: "interrupted",
        failureCode: "Interrupted",
        resumable: true,
      } as never),
      summary({ runId: "r-fail", status: "errored", failureCode: "DriverError" }),
      summary({ runId: "r-done", status: "completed" }),
    ];
    const pane = renderPane();

    const stopped = pane.container.querySelector("[data-run-id='r-stop']") as HTMLElement;
    expect(stopped.textContent).toContain("Stopped");
    expect(stopped.textContent).toContain("process exited");
    expect(stopped.textContent).not.toContain("Interrupted");
    const failed = pane.container.querySelector("[data-run-id='r-fail']") as HTMLElement;
    expect(failed.textContent).toContain("Errored");
    expect(failed.textContent).toContain("DriverError");
    const completed = pane.container.querySelector("[data-run-id='r-done']") as HTMLElement;
    expect(completed.textContent).toContain("Completed");
    expect(completed.textContent).not.toContain("DriverError");
  });

  it("取满一页才提示截断——静默截断会读成「就这些」", () => {
    summaries = Array.from({ length: WORKFLOW_RUN_DIRECTORY_LIMIT - 1 }, (_unused, index) =>
      summary({ runId: `r-${index}` }),
    );
    const short = renderPane();
    expect(short.queryByTestId("workflow-run-directory-truncated")).toBeNull();
    cleanup();

    summaries = Array.from({ length: WORKFLOW_RUN_DIRECTORY_LIMIT }, (_unused, index) =>
      summary({ runId: `r-${index}` }),
    );
    const full = renderPane();
    expect(full.getByTestId("workflow-run-directory-truncated").textContent).toContain("64");
  });

  it("三种空态可分辨：一条都没有 / 只是某一段空 / 根本列不出来", () => {
    summaries = [];
    const empty = renderPane();
    expect(empty.getByTestId("workflow-run-directory-empty")).toBeTruthy();
    expect(empty.queryByTestId("workflow-run-directory-unavailable")).toBeNull();
    cleanup();

    summaries = [summary({ runId: "r-run", status: "running" })];
    const onlyRunning = renderPane();
    expect(onlyRunning.queryByTestId("workflow-run-directory-empty")).toBeNull();
    expect(onlyRunning.getByTestId("workflow-run-directory-ended-empty")).toBeTruthy();
    cleanup();

    // Capability absent / not yet queried: the hook gives null. **Not** "nothing ran", so the empty-state copy
    // must not be borrowed.
    summaries = null;
    const unavailable = renderPane();
    expect(unavailable.getByTestId("workflow-run-directory-unavailable")).toBeTruthy();
    expect(unavailable.queryByTestId("workflow-run-directory-empty")).toBeNull();
    // Not an error either: no alert, no failure tone on screen.
    expect(unavailable.container.querySelector("[role='alert']")).toBeNull();
  });

  it("中文文案（分区标题与状态词都走 i18n，不写死英文）", () => {
    summaries = [
      summary({ runId: "r-run", status: "running" }),
      summary({ runId: "r-fail", status: "errored" }),
    ];
    const pane = renderPane("zh-CN");

    // The section title is a combined "title · count" node, so match by substring (the count itself has its own
    // testid).
    expect(pane.getByText(/正在运行/)).toBeTruthy();
    expect(pane.getByText(/已结束/)).toBeTruthy();
    expect(
      (pane.container.querySelector("[data-run-id='r-fail']") as HTMLElement).textContent,
    ).toContain("出错");
  });
});
