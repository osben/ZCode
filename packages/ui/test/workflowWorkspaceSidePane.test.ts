// @vitest-environment jsdom

// Script transcript panel (docs/dynamic-workflow/transcript-and-notifications.md "The panel"; visuals: the logbook,
// docs/dynamic-workflow/presentation.md "The pill" visual revision): a run's
// files.* / git.* / world.run replayed into chapters + two-line entries + a time ruler + command output tails.
// What is pinned here is "the manifest wired onto the DOM" — chapter heads, verb and object, result lines, status
// words, peek and expand, placeholder, landing — while the derivation rules live in
// workflowWorkspaceTranscript.test.ts and workflowWorkspaceLogbook.test.ts.
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowWorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

const release = vi.fn();
const layer = { acquire: vi.fn(() => ({ release })) };
const workflowRunWorkspace = vi.fn<() => Promise<V4ConversationWorkflowRunWorkspaceResult>>();
const workflowRunNodeResult = vi.fn<() => Promise<V4ConversationWorkflowRunNodeResultResult>>();
const onOpenCodeViewer = vi.fn();
const conversation = { layer, workflowRunWorkspace, workflowRunNodeResult };

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => conversation,
}));

let snapshot: unknown = null;
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({ snapshot }),
}));

// eslint-disable-next-line import/first -- The component under test must be imported after all mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowWorkspaceSidePane } from "@/app-shell/WorkflowWorkspaceSidePane.js";
// eslint-disable-next-line import/first
import { openWorkflowWorkspaceSidePane } from "@/lib/workspaceSidePane.js";
// eslint-disable-next-line import/first
import { resetWorkflowRunNodeResultCache } from "@/hooks/useWorkflowRunNodeResult.js";
// eslint-disable-next-line import/first
import { resetWorkspaceEntryOpenState } from "@/app-shell/workflowWorkspaceLogbook.js";

function tabOf(
  overrides: Partial<WorkflowWorkspaceSidePaneTab> = {},
): WorkflowWorkspaceSidePaneTab {
  const state = openWorkflowWorkspaceSidePane(null, {
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    parentSessionId: "parent-a",
    toolCallId: "tool-wf-1",
    runId: "dwfrun-1",
    workflowName: "Fan-out review",
  });
  return { ...(state.tabs[0] as WorkflowWorkspaceSidePaneTab), ...overrides };
}

const GRAPH = {
  steps: [
    { id: "ask#1", kind: "ask", label: "plan", lane: "actor#1", phase: "phase#a" },
    { id: "world-read#1", kind: "world-read", label: "glob", lane: "workspace", phase: "phase#a" },
    {
      id: "world-read#2",
      kind: "world-read",
      label: "run tests",
      lane: "workspace",
      phase: "phase#b",
    },
  ],
  lanes: [{ id: "actor#1", name: "planner" }, { id: "workspace" }],
  participants: [
    { id: "phase#a:actor#1", phase: "phase#a", lane: "actor#1", steps: ["ask#1"] },
    { id: "phase#a:workspace", phase: "phase#a", lane: "workspace", steps: ["world-read#1"] },
    { id: "phase#b:workspace", phase: "phase#b", lane: "workspace", steps: ["world-read#2"] },
  ],
  handoffs: [],
  phases: [
    { id: "phase#a", name: "plan", line: 1 },
    { id: "phase#b", name: "verify", line: 5 },
  ],
  phaseEdges: [{ from: "phase#a", to: "phase#b" }],
  exits: ["phase#b"],
};

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 3,
    ...overrides,
  };
}

function setSnapshot(options: { run?: WorkflowRunState; withGraph?: boolean } = {}) {
  snapshot = {
    rows: {
      window:
        options.withGraph === false
          ? []
          : [
              {
                kind: "toolCall",
                rowId: "row-1",
                toolCallId: "tool-wf-1",
                toolName: "CreateWorkflow",
                status: "success",
                inputText: "",
                display: {
                  kind: "create_workflow",
                  ok: true,
                  errorCount: 0,
                  diagnostics: [],
                  causalityGraph: GRAPH,
                },
              },
            ],
    },
    ...(options.run ? { workflowRuns: { revision: 1, runs: [options.run] } } : {}),
  };
}

const NODES: V4ConversationWorkflowRunWorkspaceResult["nodes"] = [
  {
    siteId: "world-read#1",
    ordinal: 1,
    kind: "world-read",
    op: "glob",
    args: ["src/**/*.ts"],
    status: "completed",
    summary: { resultBytes: 30, resultCount: 2 },
    createdAt: 1_000,
    updatedAt: 1_120,
  },
  {
    siteId: "world-read#1",
    ordinal: 2,
    kind: "world-read",
    op: "read",
    args: ["src/a.ts"],
    status: "completed",
    summary: { resultBytes: 20 },
    createdAt: 1_200,
    updatedAt: 1_210,
  },
  {
    siteId: "world-read#2",
    ordinal: 1,
    kind: "world-run",
    op: "run",
    args: ["pnpm", ["test"]],
    status: "completed",
    summary: { resultBytes: 60, exitCode: 1, stdoutBytes: 9, stderrBytes: 4 },
    createdAt: 2_000,
    updatedAt: 3_300,
  },
  {
    siteId: "world-read#2",
    ordinal: 2,
    kind: "world-run",
    op: "run",
    args: ["pnpm", ["test"]],
    status: "running",
    createdAt: 4_000,
    updatedAt: 4_000,
  },
];

function renderPane(tab = tabOf(), locale: "en-US" | "zh-CN" = "en-US") {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowWorkspaceSidePane, { tab, focused: true, onOpenCodeViewer }),
    ),
  );
}

beforeEach(() => {
  cleanup();
  resetWorkflowRunNodeResultCache();
  resetWorkspaceEntryOpenState();
  layer.acquire.mockClear();
  release.mockClear();
  onOpenCodeViewer.mockClear();
  workflowRunWorkspace.mockReset();
  workflowRunNodeResult.mockReset();
  workflowRunWorkspace.mockResolvedValue({ nodes: NODES });
  workflowRunNodeResult.mockResolvedValue({
    status: "completed",
    result: { exitCode: 1, stdout: "1 failed\n", stderr: "boom" },
    truncated: false,
    totalBytes: 60,
  });
  setSnapshot({ run: run() });
});

describe("WorkflowWorkspaceSidePane", () => {
  it("订阅父会话、按 run 查清单，卡片按执行顺序、按 op 分种类", async () => {
    const view = renderPane();
    expect(layer.acquire).toHaveBeenCalledWith("parent-a");
    await waitFor(() => expect(view.getAllByTestId("workflow-workspace-card")).toHaveLength(4));
    expect(workflowRunWorkspace).toHaveBeenCalledWith({ sessionId: "parent-a", runId: "dwfrun-1" });
    const cards = view.getAllByTestId("workflow-workspace-card");
    expect(cards.map((card) => card.getAttribute("data-site-id"))).toEqual([
      "world-read#1",
      "world-read#1",
      "world-read#2",
      "world-read#2",
    ]);
    // Two-line entries: verb + object, then the result line; the right side shows the time relative to the first card.
    expect(cards[0]!.textContent).toContain("Searched");
    expect(cards[0]!.textContent).toContain("src/**/*.ts");
    expect(cards[0]!.textContent).toContain("2 files");
    expect(cards[1]!.textContent).toContain("Read");
    expect(cards[1]!.textContent).toContain("a.ts");
    expect(cards[2]!.textContent).toContain("Ran");
    expect(cards[2]!.textContent).toContain("pnpm test");
    const whenOf = (card: HTMLElement) =>
      card.querySelector('[data-testid="workflow-workspace-when"]')!.textContent;
    expect(cards.map(whenOf)).toEqual(["+0:00", "+0:00", "+0:01", "now"]);
    // The running one: the verb reads "Running" with a shine sweep, and the result line says how long ago it started.
    expect(cards[3]!.textContent).toContain("Running");
    expect(cards[3]!.textContent).toContain("started");
    expect(cards[3]!.querySelector(".wf-ws-shine")).toBeTruthy();
    expect(cards[3]!.getAttribute("data-status")).toBe("running");
    // Read is not expandable; the rest carry button semantics.
    expect(cards[1]!.getAttribute("role")).toBeNull();
    expect(cards[2]!.getAttribute("role")).toBe("button");
    // The first batch arrives one by one: each card staggered by 24 ms.
    expect(cards[1]!.style.animationDelay).toBe("24ms");
  });

  it("阶段是章：章头带名字、步数与时长，卡按执行顺序落在章里；图不可得时没有章头", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getAllByTestId("workflow-workspace-card")).toHaveLength(4));
    const chapters = view.getAllByTestId("workflow-workspace-chapter");
    expect(chapters.map((chapter) => chapter.getAttribute("data-phase-id"))).toEqual([
      "phase#a",
      "phase#b",
    ]);
    expect(chapters[0]!.textContent).toContain("plan");
    expect(chapters[0]!.textContent).toContain("2 steps");
    expect(chapters[1]!.textContent).toContain("verify");
    // The chapter head's rule grows out from the left.
    expect(chapters[0]!.querySelector(".wf-ws-rule")).toBeTruthy();
    const cards = view.getAllByTestId("workflow-workspace-card");
    expect(cards[0]!.getAttribute("data-phase-id")).toBe("phase#a");
    expect(cards[2]!.getAttribute("data-phase-id")).toBe("phase#b");
    // Header second line: the logbook's three totals.
    const summary = view.getByTestId("workflow-workspace-summary").textContent;
    expect(summary).toContain("2 phases");
    expect(summary).toContain("4 steps");
    cleanup();
    setSnapshot({ run: run(), withGraph: false });
    const bare = renderPane();
    await waitFor(() => expect(bare.getAllByTestId("workflow-workspace-card")).toHaveLength(4));
    expect(bare.queryByTestId("workflow-workspace-chapter")).toBeNull();
    expect(bare.getAllByTestId("workflow-workspace-card")[0]!.hasAttribute("data-phase-id")).toBe(
      false,
    );
    expect(bare.getByTestId("workflow-workspace-summary").textContent).not.toContain("phases");
  });

  it("状态词：跑完的命令说 exit n，非零红；失败行说 code（超时说 timed out）", async () => {
    workflowRunWorkspace.mockResolvedValue({
      nodes: [
        NODES[2]!,
        {
          ...NODES[3]!,
          status: "failed",
          error: { code: "DriverError", message: "command timed out after 300000ms" },
        },
      ],
    });
    const view = renderPane();
    await waitFor(() => expect(view.getAllByTestId("workflow-workspace-status")).toHaveLength(2));
    const [exit, timedOut] = view.getAllByTestId("workflow-workspace-status");
    expect(exit!.textContent).toBe("exit 1");
    expect(exit!.getAttribute("data-failed")).toBe("true");
    expect(exit!.className).toContain("text-destructive");
    expect(timedOut!.textContent).toBe("timed out");
  });

  it("收起的命令露出输出的尾巴（peek，正文按卡取一次）；展开是完整面板：$ 命令行、stdout、单独成段的 stderr、页脚 + Copy", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getAllByTestId("workflow-workspace-card")).toHaveLength(4));
    // Only finished commands fetch their body (jsdom has no IntersectionObserver → treated as immediately visible);
    // running ones do not.
    await waitFor(() => expect(workflowRunNodeResult).toHaveBeenCalledTimes(1));
    expect(workflowRunNodeResult).toHaveBeenCalledWith({
      sessionId: "parent-a",
      runId: "dwfrun-1",
      siteId: "world-read#2",
      ordinal: 1,
    });
    const terminal = view.getAllByTestId("workflow-workspace-card")[2]!;
    const peek = () => terminal.querySelector('[data-testid="workflow-workspace-peek"]');
    await waitFor(() => expect(peek()!.textContent).toContain("1 failed"));
    expect(terminal.querySelector('[data-testid="workflow-workspace-card-body"]')).toBeNull();

    await act(async () => {
      fireEvent.click(terminal);
    });
    await waitFor(() => expect(view.getByTestId("workflow-workspace-card-footer")).toBeTruthy());
    // Expanding does not fetch again: peek already put the body into the cache.
    expect(workflowRunNodeResult).toHaveBeenCalledTimes(1);
    expect(terminal.getAttribute("aria-expanded")).toBe("true");
    expect(peek()).toBeNull();
    const body = view.getByTestId("workflow-workspace-card-body");
    expect(body.textContent).toContain("pnpm test");
    expect(body.textContent).toContain("1 failed");
    expect(view.getByTestId("workflow-workspace-stderr").textContent).toContain("boom");
    const footer = view.getByTestId("workflow-workspace-card-footer");
    expect(footer.textContent).toContain("exit 1");
    expect(footer.textContent).toContain("1.3s");
    expect(footer.textContent).toContain("9 B");
    expect(footer.querySelector('[data-testid="workflow-workspace-copy"]')).toBeTruthy();
    // Clicks inside the body do not collapse it.
    await act(async () => {
      fireEvent.click(body);
    });
    expect(terminal.getAttribute("aria-expanded")).toBe("true");
    // Keyboard: Enter collapses.
    await act(async () => {
      fireEvent.keyDown(terminal, { key: "Enter" });
    });
    expect(terminal.getAttribute("aria-expanded")).toBe("false");
  });

  it("Read 卡只有摘要行：不可展开，文件芯片开代码查看器（相对路径补成工作区绝对路径）", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getAllByTestId("workflow-workspace-card")).toHaveLength(4));
    const read = view.getAllByTestId("workflow-workspace-card")[1]!;
    const chip = read.querySelector("button[title]")!;
    fireEvent.click(chip);
    expect(onOpenCodeViewer).toHaveBeenCalledWith({
      type: "file",
      title: "a.ts",
      path: "/workspace/src/a.ts",
    });
    // Read never fetches a body (only the finished command fetched one, for peek).
    expect(workflowRunNodeResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "world-read#1" }),
    );
  });

  it("活投影说是缓存命中的行带 replayed 芯片", async () => {
    setSnapshot({
      run: run({
        nodes: [
          { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok", cached: true },
        ] as WorkflowRunState["nodes"],
      }),
    });
    const view = renderPane();
    await waitFor(() => expect(view.getAllByTestId("workflow-workspace-replayed")).toHaveLength(1));
    expect(view.getAllByTestId("workflow-workspace-card")[0]!.textContent).toContain("replayed");
  });

  it("落点：从一站开滚到该站的第一张卡并亮一下；还没到的站滚到末尾", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push((this as HTMLElement).getAttribute("data-site-id") ?? "?");
    };
    const view = renderPane(tabOf({ focusPhaseId: "phase#b" }));
    await waitFor(() => expect(scrolled).toEqual(["world-read#2"]));
    const landed = view.getAllByTestId("workflow-workspace-card")[2]!;
    expect(landed.className).toContain("wf-ws-landed");
    expect(view.getAllByTestId("workflow-workspace-card")[0]!.className).not.toContain(
      "wf-ws-landed",
    );
    cleanup();

    const toEnd = vi.fn();
    HTMLElement.prototype.scrollTo = toEnd as never;
    renderPane(tabOf({ focusPhaseId: "phase#zzz" }));
    await waitFor(() => expect(toEnd).toHaveBeenCalled());
  });

  it("表头：终端瓦片 · SCRIPT 眉题 · run 名 · run 灯与词；清单到齐前没有第二行", async () => {
    const view = renderPane();
    expect(view.getByTestId("workflow-workspace-title").textContent).toBe("Fan-out review");
    expect(view.getByTestId("workflow-workspace-run-status").textContent).toBe("Running");
    expect(view.getByTestId("workflow-workspace-pane").textContent).toContain("Script");
    expect(view.queryByTestId("workflow-workspace-summary")).toBeNull();
    await waitFor(() => expect(view.getByTestId("workflow-workspace-summary")).toBeTruthy());
  });

  it("整个 run 还没碰过工作区：占位，双语可读", async () => {
    workflowRunWorkspace.mockResolvedValue({ nodes: [] });
    const en = renderPane();
    await waitFor(() => expect(en.getByTestId("workflow-workspace-not-started")).toBeTruthy());
    expect(en.getByTestId("workflow-workspace-not-started").textContent).toContain(
      "The script has not run anything yet",
    );
    cleanup();
    const zh = renderPane(tabOf(), "zh-CN");
    await waitFor(() => expect(zh.getByTestId("workflow-workspace-not-started")).toBeTruthy());
    expect(zh.getByTestId("workflow-workspace-not-started").textContent).toContain(
      "脚本还没执行任何步骤",
    );
  });

  it("能力缺席（老 CLI）：说清读不到，而不是当成空 run", async () => {
    workflowRunWorkspace.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("workflow-workspace-unavailable")).toBeTruthy());
    expect(view.queryByTestId("workflow-workspace-not-started")).toBeNull();
  });

  it("清单被网关截尾时页尾说明只显示前 N 步", async () => {
    workflowRunWorkspace.mockResolvedValue({ nodes: NODES, truncated: true });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("workflow-workspace-truncated")).toBeTruthy());
    expect(view.getByTestId("workflow-workspace-truncated").textContent).toContain("first 4 steps");
  });
});
