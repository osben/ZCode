import type { IBroadcastService } from "@zcode/services";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildNodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => localStorageState.clear(),
    getItem: (key: string) => localStorageState.get(key) ?? null,
    removeItem: (key: string) => localStorageState.delete(key),
    setItem: (key: string, value: string) => localStorageState.set(key, value),
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      classList: {
        contains: () => false,
        toggle: () => {},
      },
    },
  },
});

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

const displayModel = {
  inlinePreview: { type: "none" as const },
  planResult: null,
  viewerSource: null,
  viewerLabelId: "codeViewer.viewCode" as const,
  showSummaryFileLink: false,
  showInput: false,
  showOutput: false,
  showKind: false,
};

function renderWithProviders(element: ReactElement) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
      createElement(
        StoreProvider,
        { broadcastService: mockBroadcastService },
        createElement(TooltipProvider, null, element),
      ),
    ),
  );
}

describe("node repl tool display", () => {
  it("normalizes user title, code and projected text output", () => {
    expect(
      buildNodeReplDisplayModel({
        toolId: "tool-node-repl-model",
        toolName: "js",
        kind: "js",
        title: "js",
        input: {
          code: "globalThis.browser = await agent.browsers.getDefault();",
          title: "Select the browser and read the instructions",
        },
        output: {
          type: "text",
          value: "# Selected Browser\n- Name: ZCode In-app Browser",
        },
        status: "completed",
      }),
    ).toMatchObject({
      operation: "run",
      userTitle: "Select the browser and read the instructions",
      code: "globalThis.browser = await agent.browsers.getDefault();",
      resultText: "# Selected Browser\n- Name: ZCode In-app Browser",
    });
  });

  it("removes leading blank code lines without changing the first line indentation", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-leading-code-lines",
      toolName: "js",
      kind: "js",
      title: "Check the page",
      input: { code: "\n \t\r\n  const title = await tab.title();\n  return title;\n" },
      output: { type: "text", value: "Example" },
      status: "completed",
    });

    expect(model.code).toBe("  const title = await tab.title();\n  return title;\n");
  });

  it("extracts text and image blocks from the real MCP CallToolResult shape", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-mcp-content",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "Check the page screenshot",
      input: { code: "await nodeRepl.emitImage(await tab.screenshot());" },
      output: {
        content: [
          { type: "text", text: "=> ready" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
      status: "completed",
    });

    expect(model.resultText).toBe("ready");
    expect(model.images).toEqual([{ base64: "AAAA", mimeType: "image/png" }]);
  });

  it("keeps snapshot display images without the model-facing attachment placeholder", () => {
    const toolCall = {
      toolId: "tool-node-repl-display-image",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "View screenshot",
      input: { code: "nodeRepl.emitImage(await tab.screenshot());" },
      output: "(no output)\n[Attached image/png: MCP image]",
      raw: {
        schemaVersion: 1,
        display: {
          kind: "node_repl_images",
          images: [{ base64: "AAAA", mimeType: "image/png" }],
        },
      },
      status: "completed",
    } as const;
    const model = buildNodeReplDisplayModel(toolCall);
    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
        workspacePath: "/workspace",
        displayModel,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: expectedCopy("chat.toolCall.status.completed"),
        childToolList: null,
        forceOpen: true,
        canToggle: true,
        showIcon: true,
      }),
    );

    expect(model.resultText).toBeUndefined();
    expect(model.images).toEqual([{ base64: "AAAA", mimeType: "image/png" }]);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain("Attached image");
  });

  it("projects the CUA App identity while the summary keeps the model title without repeating the App name", () => {
    const toolCall = {
      toolId: "tool-node-repl-cua-app",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "Create a new note",
      input: { code: "await app.elements(); await el.click();", title: "Create a new note" },
      output: "clicked",
      raw: {
        schemaVersion: 1,
        display: {
          kind: "node_repl_images",
          app: { appKey: "darwin:com.apple.notes", displayName: "Notes" },
        },
      },
      status: "completed",
    } as const;

    const model = buildNodeReplDisplayModel(toolCall);
    expect(model.app).toEqual({ appKey: "darwin:com.apple.notes", displayName: "Notes" });

    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
        workspacePath: "/workspace",
        displayModel,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: expectedCopy("chat.toolCall.status.completed"),
        childToolList: null,
        forceOpen: false,
        canToggle: true,
        showIcon: true,
      }),
    );

    // The summary row still shows only the model-provided title without
    // appending the App name (it would duplicate the title).
    expect(html).toContain("Create a new note");
    expect(html).not.toContain("Notes");
  });

  it("keeps the original node_repl icon path when there is no App identity", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-no-app",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "Do a quick calculation",
      input: { code: "1 + 1" },
      output: "=> 2",
      status: "completed",
    });

    expect(model.app).toBeUndefined();
  });

  it("renders a browser turn-end screenshot as a standalone image", () => {
    const toolCall = {
      toolId: "tool-browser-turn-screenshot",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      input: { source: "browser_turn_end" },
      output: "",
      raw: {
        schemaVersion: 1,
        display: {
          kind: "node_repl_images",
          source: "browser_turn_end",
          images: [{ base64: "AAAA", mimeType: "image/png" }],
        },
      },
      status: "completed",
    } as const;
    const model = buildNodeReplDisplayModel(toolCall);
    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
        workspacePath: "/workspace",
        displayModel,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: expectedCopy("chat.toolCall.status.completed"),
        childToolList: null,
        showIcon: true,
      }),
    );

    expect(model.displaySource).toBe("browser_turn_end");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain(expectedCopy("chat.toolCall.nodeRepl.details"));
    expect(html).not.toContain("Run JavaScript");
  });

  it("removes internal completion markers from projected results", () => {
    const createModel = (value: string) =>
      buildNodeReplDisplayModel({
        toolId: "tool-node-repl-completion-marker",
        toolName: "js",
        kind: "js",
        title: "Open the target page",
        input: { code: "await tab.goto('https://example.com');" },
        output: { type: "text", value },
        status: "completed",
      });

    expect(createModel("=> Opened the target page").resultText).toBe("Opened the target page");
    expect(createModel("Page loaded\n=> Opened the target page").resultText).toBe(
      "Page loaded\nOpened the target page",
    );
  });

  it("removes the persisted-output envelope while preserving the full result reference", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-artifact",
      toolName: "js",
      kind: "js",
      title: "js",
      input: { code: "nodeRepl.write(largeResult);" },
      output: {
        type: "text",
        value:
          "<persisted-output>\nOutput too large (31 KB). Full output saved to: /tmp/full-result.json\n\nPreview (first 2 KB):\npreview text\n</persisted-output>",
      },
      status: "completed",
    });

    expect(model.resultText).toBe("preview text");
    expect(model.persistedResult).toEqual({
      artifactPath: "/tmp/full-result.json",
      sizeLabel: "31 KB",
    });
  });

  it("rejects implementation-only titles and extracts structured failures", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-error",
      toolName: "js",
      kind: "js",
      title: "js",
      input: {
        code: "throw new Error('boom');",
        title: "Run JavaScript",
      },
      output: {
        logs: "",
        error: {
          name: "Error",
          message: "boom",
          stack: "Error: boom\n    at cell:1:1",
        },
      },
      status: "failed",
    });

    expect(model.userTitle).toBeUndefined();
    expect(model.error).toEqual({
      summary: "Error: boom",
      stack: "Error: boom\n    at cell:1:1",
    });
  });

  it("routes runs to a user-friendly result-first renderer without raw payloads", () => {
    const toolCall = {
      toolId: "tool-node-repl-render",
      toolName: "js",
      kind: "js",
      title: "js",
      input: {
        code: "globalThis.browser = await agent.browsers.getDefault();",
        title: "Select the browser and read the instructions",
      },
      output: {
        type: "text",
        value: "Selected the in-app browser and read the instructions.",
      },
      status: "completed" as const,
      raw: {
        toolId: "raw-tool-id-should-not-render",
        toolName: "js",
        rawInput: { secretDebugField: "hidden" },
      },
    };
    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
        workspacePath: "/workspace",
        displayModel,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: expectedCopy("chat.toolCall.status.completed"),
        childToolList: null,
        forceOpen: true,
        canToggle: true,
        showIcon: true,
      }),
    );

    expect(html).toContain("Select the browser and read the instructions");
    expect(html).toContain(expectedCopy("chat.toolCall.nodeRepl.completed"));
    expect(html).toContain("Selected the in-app browser and read the instructions.");
    expect(html).not.toContain(`>${expectedCopy("chat.toolCall.nodeRepl.result")}</span>`);
    expect(html).not.toContain(`aria-label="${expectedCopy("chat.toolCall.nodeRepl.copyResult")}"`);
    expect(html).toContain(expectedCopy("chat.toolCall.nodeRepl.details"));
    expect(html).not.toContain("Parameters");
    expect(html).not.toContain("raw-tool-id-should-not-render");
    expect(html).not.toContain("secretDebugField");
  });

  it("recovers the user title from serialized input when the projected input only has code", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-serialized-title",
      toolName: "js",
      kind: "js",
      title: "js",
      input: { code: "return await tab.title();" },
      output: { type: "text", value: "Example" },
      status: "completed",
      raw: {
        rawInput: JSON.stringify({
          code: "return await tab.title();",
          title: "Read the current page title",
        }),
      },
    });

    expect(model.userTitle).toBe("Read the current page title");
  });

  it("uses friendly summaries for reset and working-directory configuration", () => {
    const resetHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-reset",
            toolName: "js_reset",
            kind: "js_reset",
            title: "js_reset",
            input: {},
            output: { ok: true },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );
    const configureHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-configure",
            toolName: "js_add_node_module_dir",
            kind: "js_add_node_module_dir",
            title: "js_add_node_module_dir",
            input: { dir: "/workspace/node_modules" },
            output: { ok: true, dirs: ["/workspace/node_modules"] },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );

    expect(resetHtml).toContain(expectedCopy("chat.toolCall.nodeRepl.reset"));
    expect(resetHtml).not.toContain("&quot;ok&quot;");
    expect(configureHtml).toContain(expectedCopy("chat.toolCall.nodeRepl.configured"));
    expect(configureHtml).toContain("/workspace/node_modules");
    expect(configureHtml).not.toContain("&quot;dirs&quot;");
  });

  it("recognizes the Codex-compatible MCP node_repl tool names", () => {
    const resetHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-mcp-reset",
            toolName: "mcp__node_repl__js_reset",
            kind: "mcp__node_repl__js_reset",
            title: "mcp__node_repl__js_reset",
            input: {},
            output: { ok: true },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );
    const configureHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-mcp-configure",
            toolName: "mcp__node_repl__js_add_node_module_dir",
            kind: "mcp__node_repl__js_add_node_module_dir",
            title: "mcp__node_repl__js_add_node_module_dir",
            input: { path: "/workspace/node_modules" },
            output: { ok: true },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );

    expect(resetHtml).toContain(expectedCopy("chat.toolCall.nodeRepl.reset"));
    expect(configureHtml).toContain(expectedCopy("chat.toolCall.nodeRepl.configured"));
    expect(configureHtml).toContain("/workspace/node_modules");
  });

  it("keeps the Node REPL renderer when MCP presentation metadata is present", () => {
    const html = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-mcp-presentation",
            toolName: "mcp__node_repl__js",
            kind: "mcp__node_repl__js",
            input: {
              code: "return await tab.title();",
              title: "Read the current page title",
            },
            output: {
              content: [{ type: "text", text: "=> Example" }],
            },
            raw: {
              display: {
                kind: "mcp_tool",
                serverName: "node_repl",
                toolName: "js",
                description: "Run JavaScript in the persistent Node kernel.",
              },
            },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );

    expect(html).toContain("Read the current page title");
    expect(html).toContain("lucide-square-mouse-pointer");
    expect(html).not.toContain(">Node repl<");
  });
});
