// @vitest-environment jsdom

// The artifact row (docs/dynamic-workflow/transcript-and-notifications.md "Artifact tiles") and
// its two presentation rules (`resolvePrimaryArtifact` / `orderArtifactsPrimaryFirst`,
// docs/dynamic-workflow/authoring.md "Ids, tags and versions"). The row's **placement** on the
// completion card and the run side panel is covered by workflowCompletionCard.test.ts and
// workflowRunArtifactsSection.test.ts; here we only pin the row's own shape and the two pure functions.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  buildPresetLabels,
  orderArtifactsPrimaryFirst,
  resolvePrimaryArtifact,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactRow } from "@/components/workflow-timeline/WorkflowArtifactRow.js";
import type { WorkflowCompletionArtifact } from "@/components/workflow-timeline/WorkflowArtifactTile.js";

afterEach(() => {
  cleanup();
});

const REPORT: WorkflowCompletionArtifact = {
  id: "report",
  kind: "file",
  title: "季度基准报告",
  description: "对比十二个服务的 p50 / p99 延迟与上季度基线。",
  contentType: "application/pdf",
  sourcePath: "out/report.pdf",
  bytes: 4_194_304,
  version: 2,
  primary: true,
};

function renderRow(
  artifact: WorkflowCompletionArtifact,
  options: { locale?: "en-US" | "zh-CN"; onOpen?: (id: string) => void; title?: string } = {},
) {
  const labels = buildPresetLabels((descriptor) => descriptor.id.split(".").at(-1)!);
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: options.locale ?? "en-US" },
      createElement(WorkflowArtifactRow, {
        artifact,
        labels,
        ...(options.onOpen === undefined ? {} : { onOpen: options.onOpen }),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    ),
  );
}

describe("WorkflowArtifactRow", () => {
  it("one button: the preview frame is an inert sibling; detail, version, and open callback stay faithful", () => {
    const onOpen = vi.fn();
    const view = renderRow(REPORT, { onOpen });
    const row = view.getByTestId("workflow-artifact-row") as HTMLButtonElement;
    expect(row.tagName).toBe("BUTTON");
    // Frame and button are siblings: controls inside the markdown thumbnail (a table's copy
    // button) must not nest inside the button; the hit area is laid out by ::after.
    const shell = row.parentElement!;
    expect(row.className).toContain("wf-tile-hit");
    const frame = view.getByTestId("workflow-artifact-row-frame");
    expect(frame.parentElement).toBe(shell);
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(row.contains(frame)).toBe(false);
    expect(row.getAttribute("data-variant")).toBe("row");
    expect(row.getAttribute("title")).toBe("File · 季度基准报告");
    const detail = view.getByTestId("workflow-artifact-row-detail");
    expect(detail.textContent).toBe("File·PDF·4.00 MB");
    expect(view.getByTestId("workflow-run-artifact-badge").textContent).toBe("PDF");
    expect(view.getByTestId("workflow-run-artifact-bytes").textContent).toBe("4.00 MB");
    expect(view.getByTestId("workflow-artifact-tile-version").textContent).toBe("v2");
    expect(view.getByTestId("workflow-artifact-tile-open")).toBeTruthy();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith("report");
    // No "primary" wording.
    expect(row.textContent).not.toMatch(/primary/iu);
  });

  it("no callback: disabled, no aria-label, no ↗; description and version remain; the host can override the tooltip", () => {
    const view = renderRow(REPORT, { title: "File · 季度基准报告\nout/report.pdf" });
    const row = view.getByTestId("workflow-artifact-row") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-label")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-tile-open")).toBeNull();
    expect(view.getByTestId("workflow-artifact-tile-version").textContent).toBe("v2");
    expect(row.getAttribute("title")).toBe("File · 季度基准报告\nout/report.pdf");
  });

  it.each([["zh-CN"]] as const)(
    "a chart's detail is the item count; a missing description omits the line; v1 writes no version; zh-CN kind word",
    (locale) => {
      const view = renderRow(
        { id: "perf", kind: "chart", title: "每轮耗时", version: 1, itemCount: 12 },
        { locale },
      );
      expect(view.queryByTestId("workflow-artifact-row-description")).toBeNull();
      expect(view.queryByTestId("workflow-artifact-tile-version")).toBeNull();
      expect(view.getByTestId("workflow-artifact-row-detail").textContent).toBe("图表·items");
      cleanup();
      // Bytes unknown, no item count: only the kind word, no dot.
      const bare = renderRow({ id: "notes", kind: "markdown", version: 1 });
      expect(bare.getByTestId("workflow-artifact-row-detail").textContent).toBe("Document");
    },
  );
});

describe("resolvePrimaryArtifact / orderArtifactsPrimaryFirst", () => {
  const a = { id: "a" };
  const b = { id: "b", primary: true as const };
  const c = { id: "c" };

  it("the flag wins regardless of position; without a flag only a single item counts as the artifact; two or more without a flag ⇒ none", () => {
    expect(resolvePrimaryArtifact([a, b, c])).toBe(b);
    expect(resolvePrimaryArtifact([a])).toBe(a);
    expect(resolvePrimaryArtifact([a, c])).toBeUndefined();
    expect(resolvePrimaryArtifact([])).toBeUndefined();
  });

  it("the artifact leads and the rest keep their order; without a flag it is copied as-is (no single-item reordering — with one item there is nothing to sort)", () => {
    expect(orderArtifactsPrimaryFirst([a, b, c]).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(orderArtifactsPrimaryFirst([b, a, c]).map((x) => x.id)).toEqual(["b", "a", "c"]);
    const plain = [a, c];
    const copy = orderArtifactsPrimaryFirst(plain);
    expect(copy).toEqual(plain);
    expect(copy).not.toBe(plain);
  });
});
