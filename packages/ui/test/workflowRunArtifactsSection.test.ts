// @vitest-environment jsdom

// The Artifacts section of the run side pane: deliverable row + index, or a tile gallery
// (docs/dynamic-workflow/authoring.md "How the user sees them";
// shape in docs/dynamic-workflow/presentation.md "The run pane").
//
// ⚠ Terminology: the artifact in this section is output the script delivers to the **user** via `artifact.*`,
// distinct from the "result" (the script's top-level
// return value, for the model) — the spec's invariants require the two wordings to be distinguishable. (The
// `report` entries section was withdrawn
// at user instruction on 2026-09-04; see the same-day revision of docs/dynamic-workflow/presentation.md.)
//
// The position assertion "this section is the pane's last section" lives in workflowRunSidePane.test.ts (that's
// where the full pane exists);
// this file only pins the section's own shape and interactions.
import { createElement } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_WORKFLOW_ARTIFACTS_TOGGLE, TID_WORKFLOW_ARTIFACT_CARD } from "@zcode/shared";
import type { V4ConversationWorkflowRunArtifactDataResult } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

/** The board fetch transport surface: cases directly observe the `afterSequence` it receives (the only observable point of incremental continuation). */
const workflowRunArtifactData =
  vi.fn<
    (params: {
      sessionId: string;
      runId: string;
      artifactId: string;
      afterSequence?: number;
      limit?: number;
    }) => Promise<V4ConversationWorkflowRunArtifactDataResult>
  >();

/** The byte-reading surface: document / CSV / image thumbnails go through it; PDF and the board must not touch it. */
const workflowRunArtifactRead = vi.fn();

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ workflowRunArtifactData, workflowRunArtifactRead }),
  useHasV4Conversation: () => true,
}));

// eslint-disable-next-line import/first -- the component under test must be imported after the mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowRunArtifactsSection } from "@/app-shell/WorkflowRunArtifactsSection.js";
// eslint-disable-next-line import/first
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

const onOpenArtifact = vi.fn();

function artifact(overrides: Partial<WorkflowRunArtifactView> = {}): WorkflowRunArtifactView {
  return {
    id: "book",
    kind: "file",
    title: "审计报告",
    contentType: "application/pdf",
    bytes: 4096,
    sourcePath: "out/book.pdf",
    version: 2,
    itemCount: 0,
    ...overrides,
  };
}

function renderSection(
  artifacts: readonly WorkflowRunArtifactView[],
  options: { locale?: "en-US" | "zh-CN"; openable?: boolean } = {},
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: options.locale ?? "zh-CN" },
      createElement(WorkflowRunArtifactsSection, {
        artifacts,
        runId: "dwfrun-1",
        sessionId: "parent-a",
        ...(options.openable === false ? {} : { onOpenArtifact }),
      }),
    ),
  );
}

beforeEach(() => {
  cleanup();
  // MessageResponse picks the code block theme via matchMedia; jsdom doesn't have it.
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
  onOpenArtifact.mockClear();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
  workflowRunArtifactRead.mockReset();
});

describe("WorkflowRunArtifactsSection", () => {
  it("默认展开，卡直接在场（产物是交付物，不该藏在一次点击后面）；一件产物即交付物行", () => {
    const view = renderSection([artifact()]);
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_TOGGLE).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const cards = view.getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    expect(cards).toHaveLength(1);
    // Single-item rule: no flag and exactly one item ⇒ deliverable row (same testid; the shape is recorded in
    // data-variant).
    expect(cards[0]!.getAttribute("data-variant")).toBe("row");
    expect(view.queryByTestId("workflow-run-artifact-gallery")).toBeNull();
  });

  // Deliverable (docs/dynamic-workflow/presentation.md "The run pane", item 4): row + hairline + single-column
  // index; when collapsed the section head carries the title.
  it("有交付物：交付物行领头（容器查询下窄面板收成 136 × 85），其余是细线之下的单列索引行；收起时节头在件数后带交付物标题", () => {
    const view = renderSection([
      artifact({
        id: "perf",
        kind: "chart",
        bytes: undefined,
        sourcePath: undefined,
        version: 1,
        itemCount: 4,
      }),
      artifact({
        id: "notes",
        kind: "markdown",
        contentType: "text/markdown",
        bytes: 2048,
        sourcePath: undefined,
      }),
      artifact({ title: "审计报告", description: "本轮审计的结论与修复建议。", primary: true }),
    ]);
    const body = view.getByTestId("workflow-run-artifact-primary-body");
    expect(body.className).toContain("@container/wf-artifacts");
    const cards = within(body).getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    // The hook already ordered the list with the deliverable first; pick the row by flag here, not by position.
    expect(cards[0]!.getAttribute("data-variant")).toBe("row");
    expect(cards[0]!.getAttribute("data-artifact-id")).toBe("book");
    expect(within(cards[0]!).getByTestId("workflow-artifact-row-description").textContent).toBe(
      "本轮审计的结论与修复建议。",
    );
    expect(within(cards[0]!).getByTestId("workflow-artifact-row-detail").textContent).toBe(
      "文件·PDF·4.0 KB",
    );
    // The preview frame is the button's sibling (controls inside a thumbnail must not nest inside a button), so
    // look inside the row container.
    const frame = within(cards[0]!.parentElement!).getByTestId("workflow-artifact-row-frame");
    expect(frame.className).toContain("@max-[380px]/wf-artifacts:w-[136px]");
    expect(frame.className).toContain("@max-[380px]/wf-artifacts:h-[85px]");
    const index = view.getByTestId("workflow-run-artifact-index");
    expect(index.className).toContain("grid-cols-1");
    expect(index.className).toContain("border-t");
    const lines = within(index).getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    expect(lines.map((card) => card.getAttribute("data-artifact-id"))).toEqual(["perf", "notes"]);
    expect(lines.every((card) => card.getAttribute("data-variant") === "line")).toBe(true);
    // Index lines draw no frame; the detail sits on the line itself (count for the board, size for documents),
    // and the tooltip holds only kind word · title (+ source).
    expect(within(index).queryByTestId("workflow-artifact-tile-frame")).toBeNull();
    expect(within(lines[0]!).getByTestId("workflow-run-artifact-items").textContent).toBe("4 条");
    expect(within(lines[1]!).getByTestId("workflow-run-artifact-bytes").textContent).toBe("2.0 KB");
    expect(lines[0]!.getAttribute("title")).toBe("图表 · 审计报告");
    // Cadence: the row at 30ms, index lines following.
    expect((cards[0] as HTMLElement).style.animationDelay).toBe("30ms");
    expect((lines[0] as HTMLElement).style.animationDelay).toBe("60ms");
    // When expanded the section head doesn't repeat the title; collapsed it does.
    expect(view.queryByTestId("workflow-run-artifacts-primary-title")).toBeNull();
    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACTS_TOGGLE));
    expect(view.getByTestId("workflow-run-artifacts-count").textContent).toBe("3");
    expect(view.getByTestId("workflow-run-artifacts-primary-title").textContent).toBe("· 审计报告");
    // The word "primary" never reaches the screen.
    expect(view.container.textContent).not.toMatch(/primary/iu);
  });

  it("节身是一片画廊：一件产物一张瓦片（预览框 + 说明行），依次落地；不再有药丸行 + 挂卡", () => {
    const view = renderSection([
      artifact(),
      artifact({ id: "notes", kind: "markdown", contentType: "text/markdown", bytes: 2048 }),
      artifact({ id: "perf", kind: "chart", bytes: undefined, sourcePath: undefined, version: 1 }),
    ]);
    const gallery = view.getByTestId("workflow-run-artifact-gallery");
    const tiles = within(gallery).getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    expect(tiles).toHaveLength(3);
    // Each tile carries its own preview frame (the button's sibling, inert); PDF draws a paper-page glyph + badge.
    const tile = tiles[0]!.parentElement!;
    const frame = within(tile).getByTestId("workflow-artifact-tile-frame");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(within(tile).getByTestId("workflow-artifact-sheet-badge").textContent).toBe("PDF");
    expect(within(tiles[0]!).queryByTestId("workflow-artifact-tile-frame")).toBeNull();
    // 30ms per tile.
    expect((tiles[0] as HTMLElement).style.animationDelay).toBe("30ms");
    expect((tiles[2] as HTMLElement).style.animationDelay).toBe("90ms");
    expect(view.queryByTestId("workflow-run-artifact-row")).toBeNull();
    expect(view.queryByTestId("workflow-run-artifact-preview")).toBeNull();
  });

  it("可以手动收起，收起时表头仍报件数", () => {
    const view = renderSection([artifact(), artifact({ id: "notes", kind: "markdown" })]);
    expect(view.getByTestId("workflow-run-artifacts-count").textContent).toBe("2");

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACTS_TOGGLE));
    expect(view.queryAllByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toHaveLength(0);
    // Collapsing must not make "what this run delivered" invisible.
    expect(view.getByTestId("workflow-run-artifacts-count").textContent).toBe("2");
  });

  it("说明行带类型徽字、字节数与版本尾槽；kind 词与工作区出处进 tooltip；title 缺席时退回 id", () => {
    const view = renderSection([artifact({ title: undefined })]);
    const card = view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    // The tail slot holds the compact v2 (same in both languages); the long form lives in title.
    const version = within(card).getByTestId("workflow-artifact-tile-version");
    expect(version.textContent).toBe("v2");
    expect(version.getAttribute("title")).toBe("第 2 版");
    expect(within(card).getByTestId("workflow-run-artifact-badge").textContent).toBe("PDF");
    expect(within(card).getByTestId("workflow-run-artifact-bytes").textContent).toBe("4.0 KB");
    // The source is a path that doesn't fit on the line: it goes into the tooltip together with the kind word.
    expect(card.getAttribute("title")).toBe("文件 · book\nout/book.pdf");
    expect(view.queryByTestId("workflow-run-artifact-source-path")).toBeNull();
    // The facade's default title is already the id, so the description line falls back to the id rather than
    // staying empty.
    expect(within(card).getByText("book")).toBeTruthy();
  });

  it("英文语境下版本尾槽同样是 v{n}，tooltip 用英文", () => {
    const view = renderSection([artifact()], { locale: "en-US" });
    const version = view.getByTestId("workflow-artifact-tile-version");
    expect(version.textContent).toBe("v2");
    expect(version.getAttribute("title")).toBe("v2");
  });

  it("第 1 版不写版本号（v1 是常态，写出来是噪音）", () => {
    const view = renderSection([artifact({ version: 1 })]);
    expect(view.queryByTestId("workflow-artifact-tile-version")).toBeNull();
  });

  it("看板瓦片没有字节与出处（它的「大小」是有多少条数据）", () => {
    const view = renderSection([
      artifact({
        id: "perf",
        kind: "chart",
        title: "每轮耗时",
        bytes: undefined,
        contentType: undefined,
        sourcePath: undefined,
        version: 1,
      }),
    ]);
    expect(view.queryByTestId("workflow-run-artifact-bytes")).toBeNull();
    expect(view.queryByTestId("workflow-run-artifact-badge")).toBeNull();
    expect(view.queryByTestId("workflow-run-artifact-source-path")).toBeNull();
  });

  it("点瓦片把产物 id 交给宿主（瓦片只发意图，scope 由上层补齐）", () => {
    const view = renderSection([artifact()]);
    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenArtifact).toHaveBeenCalledWith("book");
  });

  it("瓦片是一颗真按钮（键盘激活交给浏览器，不用自己接 keydown）", () => {
    const view = renderSection([artifact()]);
    const card = view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD) as HTMLButtonElement;
    expect(card.tagName).toBe("BUTTON");
    expect(card.disabled).toBe(false);
    expect(card.getAttribute("data-artifact-open")).toBe("true");
    expect(card.getAttribute("aria-label")).toBe("打开产物: 审计报告");
  });

  it("宿主没注入打开能力时瓦片禁用，但内容照旧在场", () => {
    const view = renderSection([artifact()], { openable: false });
    const card = view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD) as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card.getAttribute("data-artifact-open")).toBeNull();
    expect(card.getAttribute("aria-label")).toBeNull();
    expect(within(card).getByText("审计报告")).toBeTruthy();
    fireEvent.click(card);
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("内容产物的瓦片不去翻 journal 的 report 行；PDF 也不读字节（画不了就不拉）", async () => {
    renderSection([artifact()]);
    await act(async () => {});
    expect(workflowRunArtifactData).not.toHaveBeenCalled();
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
  });

  it("markdown 产物的预览框里是文档开头的缩放渲染，字节走产物 tab 同一条读取", async () => {
    workflowRunArtifactRead.mockResolvedValue({
      dataBase64: btoa("# Hello\n\nBody."),
      mediaType: "text/markdown",
      totalBytes: 15,
      nextOffset: null,
    });
    const view = renderSection([
      artifact({
        id: "notes",
        kind: "markdown",
        title: "说明",
        contentType: "text/markdown",
        bytes: 15,
        sourcePath: undefined,
        version: 1,
      }),
    ]);
    await waitFor(() => expect(view.getByTestId("workflow-artifact-preview-body")).toBeTruthy());
    const body = view.getByTestId("workflow-artifact-preview-body");
    expect(body.getAttribute("data-preview-mode")).toBe("markdown");
    expect(body.textContent).toContain("Hello");
    expect(workflowRunArtifactRead).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "notes", version: 1, runId: "dwfrun-1" }),
    );
  });

  it("预置看板在预览框里实时渲染，并随 itemCount 变化带 afterSequence 增量续拉", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce({
        items: [
          { sequence: 1, siteId: "report#1", ordinal: 1, item: { round: 1, ms: 120 } },
          { sequence: 2, siteId: "report#1", ordinal: 2, item: { round: 2, ms: 90 } },
        ],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        items: [{ sequence: 3, siteId: "report#1", ordinal: 3, item: { round: 3, ms: 80 } }],
        hasMore: false,
      });

    const board = (itemCount: number): WorkflowRunArtifactView =>
      artifact({
        id: "rounds",
        kind: "table",
        title: "每轮",
        bytes: undefined,
        sourcePath: undefined,
        contentType: undefined,
        version: 1,
        itemCount,
        spec: { columns: [{ field: "round" }, { field: "ms", unit: "ms" }] },
      });

    const view = renderSection([board(2)]);
    await waitFor(() => expect(view.getAllByTestId("artifact-table-row")).toHaveLength(2));
    // Only let the CLI fetch the two columns the spec names, not the whole item.
    expect(workflowRunArtifactData).toHaveBeenCalledWith({
      sessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "rounds",
      limit: 200,
      fields: ["round", "ms"],
    });

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkflowRunArtifactsSection, {
          artifacts: [board(3)],
          runId: "dwfrun-1",
          sessionId: "parent-a",
          onOpenArtifact,
        }),
      ),
    );

    await waitFor(() => expect(view.getAllByTestId("artifact-table-row")).toHaveLength(3));
    expect(workflowRunArtifactData).toHaveBeenLastCalledWith({
      sessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "rounds",
      afterSequence: 2,
      limit: 200,
      fields: ["round", "ms"],
    });
  });

  it("spec 还没读回来时看板瓦片保持安静，不闪一句「无法渲染」", async () => {
    // Regression: the spec can only come back via the journal query; merging "not yet arrived" and "broken"
    // into one error message
    // made every board flash red text once when opened.
    const view = renderSection([
      artifact({
        id: "perf",
        kind: "chart",
        bytes: undefined,
        sourcePath: undefined,
        contentType: undefined,
        version: 1,
        spec: undefined,
      }),
    ]);
    await act(async () => {});
    expect(view.queryByTestId("workflow-run-artifact-preset-invalid")).toBeNull();
    expect(view.queryByTestId("workflow-run-artifact-preset-missing")).toBeNull();
    // The description line is still real; the preview frame stays blank.
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy();
    expect(view.getByTestId("workflow-artifact-preview-pending")).toBeTruthy();
  });

  it("spec 在场但解析不出来时，只有预览框降级成一句话，说明行照旧", async () => {
    const view = renderSection([
      artifact({
        id: "perf",
        kind: "chart",
        title: "坏看板",
        bytes: undefined,
        sourcePath: undefined,
        contentType: undefined,
        version: 1,
        spec: { nonsense: true },
      }),
    ]);
    await waitFor(() =>
      expect(view.getByTestId("workflow-run-artifact-preset-invalid")).toBeTruthy(),
    );
    expect(view.getByText("坏看板")).toBeTruthy();
  });
});
