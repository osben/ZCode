// @vitest-environment jsdom

// The completion card's **live path** ("The card" / "Fetching data" in docs/dynamic-workflow/transcript-and-notifications.md): when the session is
// present, the full list is completed on top of the notification payload (capped at 8 items) by the live projection / journal.
//
// Bug cause (2026-09-14): completion cards for runs with many artifacts wrote "还有 … 个" (N more) instead of the number. `artifactsTruncated` is
// the fact that the **payload** was capped, yet the card used it to decide between "还有 N 个" wordings, while the list had long been completed from
// the journal and the number was clearly knowable. The ellipsis is honest only when the payload is the sole source: cold rendering, old CLIs, and
// those first frames where the journal has not answered yet.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunArtifact } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

const workflowRunArtifacts = vi.fn<() => Promise<{ artifacts: WorkflowRunArtifact[] }>>();
const workflowRunArtifactData = vi.fn();
const workflowRunArtifactRead = vi.fn();
let hasConversation = true;

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ workflowRunArtifacts, workflowRunArtifactData, workflowRunArtifactRead }),
  useHasV4Conversation: () => hasConversation,
}));

// eslint-disable-next-line import/first -- the component under test must be imported after the mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
// eslint-disable-next-line import/first
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
// eslint-disable-next-line import/first
import type { WorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  hasConversation = true;
  // The markdown-truncating renderer picks code block colors via matchMedia; jsdom lacks it.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  workflowRunArtifacts.mockReset();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
  workflowRunArtifactRead.mockReset();
  workflowRunArtifactRead.mockResolvedValue({
    dataBase64: btoa("# note"),
    mediaType: "text/markdown",
    totalBytes: 6,
    nextOffset: null,
  });
});

/** 12 artifacts: the deliverable + 11 notes; the payload carries only the first 8 (deliverable first) and sets artifactsTruncated. */
const IDS = Array.from({ length: 11 }, (_unused, index) => `note-${index + 1}`);
const payloadArtifacts: WorkflowTurnCompletion["artifacts"] = [
  { id: "report", kind: "markdown", title: "审计报告", version: 1, primary: true, description: "结论" },
  ...IDS.slice(0, 7).map((id) => ({ id, kind: "markdown" as const, title: id, version: 1 })),
];
const journalArtifacts: WorkflowRunArtifact[] = [
  {
    id: "report",
    kind: "markdown",
    title: "审计报告",
    description: "结论",
    version: 1,
    versions: [{ version: 1, publishedAt: 1, bytes: 6, primary: true }],
    itemCount: 0,
    primary: true,
  },
  ...IDS.map((id) => ({
    id,
    kind: "markdown" as const,
    title: id,
    version: 1,
    versions: [{ version: 1, publishedAt: 2, bytes: 6 }],
    itemCount: 0,
  })),
];

function renderCompletion(
  truncated: boolean,
  options: {
    sessionId?: string | null;
    artifacts?: WorkflowTurnCompletion["artifacts"];
    onOpenWorkflowArtifact?: (request: unknown) => void;
  } = {},
) {
  const completion: WorkflowTurnCompletion = {
    runId: "dwfrun-1",
    name: "audit",
    durationMs: 1_000,
    artifacts: options.artifacts ?? payloadArtifacts,
    artifactsTruncated: truncated,
    summary: undefined,
  };
  const context = {
    theme: "system",
    sessionId: options.sessionId === undefined ? "session-1" : options.sessionId,
    onOpenWorkflowArtifact: options.onOpenWorkflowArtifact ?? (() => {}),
  } as unknown as ConversationRowRenderContext;
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationWorkflowCompletion, { completion, context, turnKey: "t1" }),
    ),
  );
}

describe("ConversationWorkflowCompletion · 载荷砍过之后的 `+N`", () => {
  it("journal 答过之后写真实数字（12 件：行 + 5 行索引 + 「还有 6 个」），不再是省略号", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: journalArtifacts });
    const view = renderCompletion(true);
    await waitFor(() =>
      expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 6 个"),
    );
    expect(view.getAllByTestId("workflow-completion-line")).toHaveLength(5);
    expect(view.getByTestId("workflow-completion-card-t1").textContent).not.toContain("…");
  });

  it("老 CLI（查不到 journal）：清单可能确实不全，省略号保留；journal 未答上来的首帧也是省略号", async () => {
    let resolve!: (value: { artifacts: WorkflowRunArtifact[] }) => void;
    workflowRunArtifacts.mockImplementation(
      () => new Promise<{ artifacts: WorkflowRunArtifact[] }>((r) => (resolve = r)),
    );
    const view = renderCompletion(true);
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 … 个");
    resolve({ artifacts: journalArtifacts });
    await waitFor(() =>
      expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 6 个"),
    );
    cleanup();

    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const old = renderCompletion(true);
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(old.getByTestId("workflow-completion-more").textContent).toBe("还有 … 个");
  });

  it("冷渲染（没有会话上下文）只有载荷：省略号是诚实的", () => {
    hasConversation = false;
    const view = renderCompletion(true);
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 … 个");
    expect(workflowRunArtifacts).not.toHaveBeenCalled();
  });

  it("没砍过的载荷：数字从一开始就对，journal 补齐后也不变", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: journalArtifacts.slice(0, 8) });
    const view = renderCompletion(false);
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 2 个");
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalled());
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 2 个");
  });
});

// Open request ("How the user sees them" in docs/dynamic-workflow/authoring.md): the host opens html artifacts directly as a browser tab
// based on `contentType`, and locates the original file in the workspace based on `sourcePath`. The card's list has two variants —
// cold state has only the notification payload (no provenance), the live path has the completed list — and the request must follow **whichever one was rendered at the time**.
describe("ConversationWorkflowCompletion · 交付物行交出去的打开请求", () => {
  const PAYLOAD: WorkflowTurnCompletion["artifacts"] = [
    { id: "report", kind: "file", title: "审计报告", version: 1, primary: true },
  ];

  it("journal 补齐后带上 contentType 与 sourcePath（载荷两个都没有）", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        {
          id: "report",
          kind: "file",
          title: "审计报告",
          version: 1,
          contentType: "text/html",
          sourcePath: "reports/audit.html",
          versions: [{ version: 1, publishedAt: 1, bytes: 6, primary: true }],
          itemCount: 0,
          primary: true,
        },
      ],
    });
    const onOpenWorkflowArtifact = vi.fn();
    const view = renderCompletion(false, { artifacts: PAYLOAD, onOpenWorkflowArtifact });
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalled());

    fireEvent.click(view.getByTestId("workflow-completion-row"));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      runId: "dwfrun-1",
      artifactId: "report",
      title: "审计报告",
      contentType: "text/html",
      sourcePath: "reports/audit.html",
    });
  });

  it("冷渲染只有载荷：contentType 照载荷交出，出处不编造", () => {
    hasConversation = false;
    const onOpenWorkflowArtifact = vi.fn();
    const view = renderCompletion(false, {
      artifacts: [{ ...PAYLOAD[0]!, contentType: "text/html" }],
      onOpenWorkflowArtifact,
    });

    fireEvent.click(view.getByTestId("workflow-completion-row"));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      runId: "dwfrun-1",
      artifactId: "report",
      title: "审计报告",
      contentType: "text/html",
    });
  });
});
