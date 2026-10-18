import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ExploreToolCallBlock } from "../src/ToolCallBlocks/renderers/explore.js";

function renderExplore(params: { isRunning: boolean; durationMs?: number }) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ExploreToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "explore:tool-1",
            toolName: "Explore",
            kind: "Explore",
            title: "Explore",
            input: {},
            status: params.isRunning ? "in_progress" : "completed",
            ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
          },
          childToolCalls: [
            {
              toolCall: {
                toolId: "tool-1",
                toolName: "Grep",
                kind: "Grep",
                input: { pattern: "needle" },
                status: "completed",
              },
              childToolCalls: [],
            },
            {
              toolCall: {
                toolId: "tool-2",
                toolName: "Grep",
                kind: "Grep",
                input: { pattern: "haystack" },
                status: "completed",
              },
              childToolCalls: [],
            },
          ],
        },
        workspacePath: "/workspace",
        displayModel: {
          inlinePreview: { type: "none" },
          planResult: null,
          viewerSource: null,
          viewerLabelId: "codeViewer.viewCode",
          showSummaryFileLink: true,
          showInput: false,
          showOutput: true,
          showKind: false,
        },
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: params.isRunning,
        statusLabel: params.isRunning ? "Running" : "Completed",
        childToolList: null,
        canToggle: true,
        showIcon: true,
        disableSummaryContentAnimation: true,
      }),
    ),
  );
}

describe("ExploreToolCallBlock", () => {
  it("shows the completed stage duration after the summary", () => {
    const html = renderExplore({ isRunning: false, durationMs: 4_499 });

    expect(html).toContain("2 searches");
    expect(html).toContain(">4s<");
  });

  it("does not show a duration while the stage is running", () => {
    const html = renderExplore({ isRunning: true, durationMs: 4_499 });

    expect(html).not.toContain(">4s<");
  });
});
