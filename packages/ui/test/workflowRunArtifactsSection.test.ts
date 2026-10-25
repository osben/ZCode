// @vitest-environment jsdom

// The Artifacts section of the run side pane: deliverable row + index, or a tile gallery
// (docs/dynamic-workflow/authoring.md "How the user sees them"; shape per
// docs/dynamic-workflow/presentation.md "The run pane").
//
// Terminology: artifacts in this section are outputs the script delivered to the **user** via
// `artifact.*`, which are distinct from the "result" (the script top-level return value, for
// the model) — the spec invariant requires the two wordings to stay distinguishable. (The
// `report`-entry section was removed on 2026-09-04 per user instruction; see the same-day
// revision of docs/dynamic-workflow/presentation.md.)
//
// The "this section is the panel's last section" placement assertion lives in
// workflowRunSidePane.test.ts (which has the full panel); this file only pins this section's
// own shape and interactions.
import { createElement } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_WORKFLOW_ARTIFACTS_TOGGLE, TID_WORKFLOW_ARTIFACT_CARD } from "@zcode/shared";
import type { V4ConversationWorkflowRunArtifactDataResult } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

/** The board data transport: cases observe the `afterSequence` it receives (the only observable of incremental fetches). */
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

/** The byte-read surface: document / CSV / image thumbnails go through it; PDFs and boards must not. */
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
import { expectedCopy } from "./helpers/uiCopy.js";

const onOpenArtifact = vi.fn();

function artifact(overrides: Partial<WorkflowRunArtifactView> = {}): WorkflowRunArtifactView {
  return {
    id: "book",
    kind: "file",
    title: "Audit report",
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
      { initialLocale: options.locale ?? "en-US" },
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
  // MessageResponse picks code-block colors via matchMedia; jsdom does not provide it.
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
  it("is expanded by default with the card already present (artifacts are deliverables, not hidden behind a click); one artifact means a deliverable row", () => {
    const view = renderSection([artifact()]);
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_TOGGLE).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const cards = view.getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    expect(cards).toHaveLength(1);
    // Single-item rule: no flag and only one item => deliverable row (same testid; shape recorded on data-variant).
    expect(cards[0]!.getAttribute("data-variant")).toBe("row");
    expect(view.queryByTestId("workflow-run-artifact-gallery")).toBeNull();
  });

  // Deliverables (docs/dynamic-workflow/presentation.md "The run pane", item 4): row + hairline + single-column index; the section header carries the title when collapsed.
  it("leads with the deliverable and lists other artifacts in order; collapsing still shows the count and deliverable title", () => {
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
      artifact({
        title: "Audit report",
        description: "Conclusions and fix suggestions from this audit.",
        primary: true,
      }),
    ]);
    const body = view.getByTestId("workflow-run-artifact-primary-body");
    const cards = within(body).getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    // The hook already sorted deliverables first; pick the row by its flag here, not by position.
    expect(cards[0]!.getAttribute("data-variant")).toBe("row");
    expect(cards[0]!.getAttribute("data-artifact-id")).toBe("book");
    expect(within(cards[0]!).getByTestId("workflow-artifact-row-description").textContent).toBe(
      "Conclusions and fix suggestions from this audit.",
    );
    expect(within(cards[0]!).getByTestId("workflow-artifact-row-detail").textContent).toBe(
      "File·PDF·4.0 KB",
    );
    // The preview frame is a sibling of the button (controls inside a thumbnail cannot nest in a button), so look in the tile container.
    expect(
      within(cards[0]!.parentElement!).getByTestId("workflow-artifact-row-frame"),
    ).toBeTruthy();
    const index = view.getByTestId("workflow-run-artifact-index");
    expect(index.className).toContain("border-t");
    const lines = within(index).getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    expect(lines.map((card) => card.getAttribute("data-artifact-id"))).toEqual(["perf", "notes"]);
    expect(lines.every((card) => card.getAttribute("data-variant") === "line")).toBe(true);
    // Index lines draw no frame; the detail sits on the line (item count for boards, size for documents); the tooltip holds only the kind word · title (+ source).
    expect(within(index).queryByTestId("workflow-artifact-tile-frame")).toBeNull();
    expect(within(lines[0]!).getByTestId("workflow-run-artifact-items").textContent).toBe(
      expectedCopy("chat.toolCall.workflow.run.artifacts.preset.items", { count: 4 }),
    );
    expect(within(lines[1]!).getByTestId("workflow-run-artifact-bytes").textContent).toBe("2.0 KB");
    expect(lines[0]!.getAttribute("title")).toBe(
      `${expectedCopy("chat.toolCall.workflow.run.artifacts.kind.chart")} · Audit report`,
    );
    // Cadence: rows land at 30 ms, index lines follow.
    expect((cards[0] as HTMLElement).style.animationDelay).toBe("30ms");
    expect((lines[0] as HTMLElement).style.animationDelay).toBe("60ms");
    // While expanded the header does not repeat the title; collapsed it carries it.
    expect(view.queryByTestId("workflow-run-artifacts-primary-title")).toBeNull();
    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACTS_TOGGLE));
    expect(view.getByTestId("workflow-run-artifacts-count").textContent).toBe("3");
    expect(view.getByTestId("workflow-run-artifacts-primary-title").textContent).toBe(
      "· Audit report",
    );
    // The word "primary" never reaches the screen.
    expect(view.container.textContent).not.toMatch(/primary/iu);
  });

  it("renders the section body as a gallery: one tile per artifact (preview frame + caption), landing in sequence; no more pill row + hanging card", () => {
    const view = renderSection([
      artifact(),
      artifact({ id: "notes", kind: "markdown", contentType: "text/markdown", bytes: 2048 }),
      artifact({ id: "perf", kind: "chart", bytes: undefined, sourcePath: undefined, version: 1 }),
    ]);
    const gallery = view.getByTestId("workflow-run-artifact-gallery");
    const tiles = within(gallery).getAllByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    expect(tiles).toHaveLength(3);
    // Every tile carries its own preview frame (sibling of the button, inert); PDFs draw the sheet-page glyph + badge.
    const tile = tiles[0]!.parentElement!;
    const frame = within(tile).getByTestId("workflow-artifact-tile-frame");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(within(tile).getByTestId("workflow-artifact-sheet-badge").textContent).toBe("PDF");
    expect(within(tiles[0]!).queryByTestId("workflow-artifact-tile-frame")).toBeNull();
    // One tile every 30 ms.
    expect((tiles[0] as HTMLElement).style.animationDelay).toBe("30ms");
    expect((tiles[2] as HTMLElement).style.animationDelay).toBe("90ms");
    expect(view.queryByTestId("workflow-run-artifact-row")).toBeNull();
    expect(view.queryByTestId("workflow-run-artifact-preview")).toBeNull();
  });

  it("can be collapsed manually; the header still reports the count when collapsed", () => {
    const view = renderSection([artifact(), artifact({ id: "notes", kind: "markdown" })]);
    expect(view.getByTestId("workflow-run-artifacts-count").textContent).toBe("2");

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACTS_TOGGLE));
    expect(view.queryAllByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toHaveLength(0);
    // Collapsing must not hide "what this run delivered".
    expect(view.getByTestId("workflow-run-artifacts-count").textContent).toBe("2");
  });

  it("captions carry the type badge, byte size, and version tail slot; kind word and workspace source go to the tooltip; a missing title falls back to the id", () => {
    const view = renderSection([artifact({ title: undefined })]);
    const card = view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD);
    // The tail slot holds the compact v2 (same in both languages); the long form lives in the title.
    const version = within(card).getByTestId("workflow-artifact-tile-version");
    expect(version.textContent).toBe("v2");
    expect(version.getAttribute("title")).toBe(
      expectedCopy("chat.toolCall.workflow.run.artifacts.version", { version: 2 }),
    );
    expect(within(card).getByTestId("workflow-run-artifact-badge").textContent).toBe("PDF");
    expect(within(card).getByTestId("workflow-run-artifact-bytes").textContent).toBe("4.0 KB");
    // The source is a path that does not fit on the line: it joins the kind word in the tooltip.
    expect(card.getAttribute("title")).toBe("File · book\nout/book.pdf");
    expect(view.queryByTestId("workflow-run-artifact-source-path")).toBeNull();
    // The facade's default title is the id, so the caption falls back to the id instead of staying empty.
    expect(within(card).getByText("book")).toBeTruthy();
  });

  it("keeps the same v{n} version tail in English, with an English tooltip", () => {
    const view = renderSection([artifact()], { locale: "en-US" });
    const version = view.getByTestId("workflow-artifact-tile-version");
    expect(version.textContent).toBe("v2");
    expect(version.getAttribute("title")).toBe("v2");
  });

  it("omits the version number for v1 (v1 is the norm; showing it is noise)", () => {
    const view = renderSection([artifact({ version: 1 })]);
    expect(view.queryByTestId("workflow-artifact-tile-version")).toBeNull();
  });

  it('board tiles carry no bytes and no source (their "size" is how many data rows they have)', () => {
    const view = renderSection([
      artifact({
        id: "perf",
        kind: "chart",
        title: "Latency per round",
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

  it("clicking a tile hands the artifact id to the host (tiles only emit intent; scope is filled in upstream)", () => {
    const view = renderSection([artifact()]);
    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenArtifact).toHaveBeenCalledWith("book");
  });

  it("the tile is a real button (keyboard activation is left to the browser; no custom keydown handler)", () => {
    const view = renderSection([artifact()]);
    const card = view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD) as HTMLButtonElement;
    expect(card.tagName).toBe("BUTTON");
    expect(card.disabled).toBe(false);
    expect(card.getAttribute("data-artifact-open")).toBe("true");
    expect(card.getAttribute("aria-label")).toBe(
      `${expectedCopy("chat.toolCall.workflow.run.artifacts.open")}: Audit report`,
    );
  });

  it("disables the tile when the host injects no open capability, but the content stays present", () => {
    const view = renderSection([artifact()], { openable: false });
    const card = view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD) as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card.getAttribute("data-artifact-open")).toBeNull();
    expect(card.getAttribute("aria-label")).toBeNull();
    expect(within(card).getByText("Audit report")).toBeTruthy();
    fireEvent.click(card);
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("content-artifact tiles do not page through journal report rows; PDFs do not read bytes either (nothing to draw, nothing to fetch)", async () => {
    renderSection([artifact()]);
    await act(async () => {});
    expect(workflowRunArtifactData).not.toHaveBeenCalled();
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
  });

  it("a markdown artifact's preview frame holds a scaled render of the document head; bytes go through the same read as the artifact tab", async () => {
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
        title: "Notes",
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

  it("preset boards render live in the preview frame and refetch incrementally with afterSequence as itemCount changes", async () => {
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
        title: "Rounds",
        bytes: undefined,
        sourcePath: undefined,
        contentType: undefined,
        version: 1,
        itemCount,
        spec: { columns: [{ field: "round" }, { field: "ms", unit: "ms" }] },
      });

    const view = renderSection([board(2)]);
    await waitFor(() => expect(view.getAllByTestId("artifact-table-row")).toHaveLength(2));
    // The CLI fetches only the columns named by the spec, not the whole item.
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
        { initialLocale: "en-US" },
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

  it('board tiles stay quiet while the spec has not arrived; no flashing "cannot render" line', async () => {
    // Regression: the spec only comes back with the journal query; merging "not yet" and "broken"
    // into one error line made every board flash red once on open.
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
    // The caption is still real; the preview frame stays blank.
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy();
    expect(view.getByTestId("workflow-artifact-preview-pending")).toBeTruthy();
  });

  it("degrades only the preview frame to one sentence when the spec is present but unparseable; the caption is untouched", async () => {
    const view = renderSection([
      artifact({
        id: "perf",
        kind: "chart",
        title: "Broken chart",
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
    expect(view.getByText("Broken chart")).toBeTruthy();
  });
});
