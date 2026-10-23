// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { ToolSearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

function renderContext(toolName: string): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      toolCall: { kind: "toolCall", toolName, status: "completed" },
    },
  } as unknown as ToolCallBlockRenderContext;
}

describe("search tool call renderer", () => {
  it.each(["ToolSearch", "LocalToolSearch"])(
    "renders %s history rows with the search block",
    (toolName) => {
      expect(resolveToolCallRenderer(renderContext(toolName))).toBe(ToolSearchToolCallBlock);
    },
  );
});
