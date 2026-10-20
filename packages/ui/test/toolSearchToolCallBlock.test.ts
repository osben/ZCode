import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

type ToolCall = TaskChatToolCallTreeNode["toolCall"];

function renderTool(input: unknown, overrides: Partial<ToolCall> = {}, locale = TEST_LOCALE) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "search-tools",
            toolName: "ToolSearch",
            kind: "ToolSearch",
            title: "ToolSearch",
            input,
            output: "RESULT_MUST_NOT_RENDER",
            raw: { rawOutput: "RAW_RESULT_MUST_NOT_RENDER" },
            status: "completed",
            ...overrides,
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    ),
  );
}

describe("ToolSearch summary card", () => {
  const searchWithQuery = (query: string) =>
    expectedCopy("chat.toolCall.search.toolsWithQuery", { query });
  const searchTools = expectedCopy("chat.toolCall.search.tools");
  it.each([
    [{ query: "select:TodoWrite" }, searchWithQuery("TodoWrite")],
    [{ query: "select:Read, TodoWrite,WebFetch" }, searchWithQuery("Read, TodoWrite, WebFetch")],
    [{ query: "+docs search web" }, searchWithQuery("+docs search web")],
    [{ query: "" }, searchTools],
    [undefined, searchTools],
  ])("renders query %j without an expandable result", (input, label) => {
    const html = renderTool(input);
    expect(html).toContain(label);
    expect(html).not.toContain("select:");
    expect(html).not.toContain("RESULT_MUST_NOT_RENDER");
    expect(html).not.toContain("aria-expanded=");
    expect(html).not.toContain("lucide-chevron-right");
  });

  it("uses English labels and supports kind-only history", () => {
    expect(renderTool({ query: "select:TodoWrite" }, { toolName: undefined }, "en-US")).toContain(
      "Search tools: TodoWrite",
    );
  });

  it.each(["in_progress", "failed", "stopped"] as const)(
    "keeps %s calls non-expandable without hiding failure status",
    (status) => {
      const html = renderTool({ query: "TodoWrite" }, { status, error: "SEARCH_FAILED" });
      expect(html).toContain(searchWithQuery("TodoWrite"));
      expect(html).not.toContain("aria-expanded=");
      expect(html).not.toContain("RESULT_MUST_NOT_RENDER");
      if (status === "failed") expect(html).toContain(expectedCopy("chat.toolCall.status.failed"));
    },
  );

  it("does not change WebSearch or classify ToolSearch as an Explore search", () => {
    const html = renderTool(
      { query: "TypeScript docs" },
      { toolName: "WebSearch", kind: "WebSearch" },
    );
    expect(html).toContain(
      expectedCopy("chat.toolCall.search.findWithQuery", { query: "TypeScript docs" }),
    );
    expect(html).not.toContain(searchTools);
    expect(resolveToolCallIdentity({ toolName: "ToolSearch" }).family).toBe("unknown");
  });

  it("does not route other tools by a misleading title", () => {
    expect(
      renderTool({ query: "TodoWrite" }, { toolName: "OtherTool", kind: "OtherTool" }),
    ).not.toContain(searchTools);
  });
});
