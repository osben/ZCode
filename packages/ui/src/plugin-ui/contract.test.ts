import { describe, expect, it, vi } from "vitest";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { deriveLogicalUiInstances } from "./domain/pluginUiInstancePolicy.js";
import { exampleOpenSideTab, examplePresentation } from "./contract.example.js";
import {
  PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
  buildPluginUiSidePaneTabId,
  buildPluginUiSurfaceKey,
  readPluginUiScopeRef,
  type PluginUiSessionActions,
  type PluginUiSessionCommandPort,
  type PluginUiPresentation,
} from "./contract.js";

describe("plugin-ui contract", () => {
  it("侧栏与渲染面同时隔离 workspace/session/plugin", () => {
    const request = {
      workspacePath: "/repo",
      parentSessionId: "s1",
      pluginId: "p",
      toolCallId: "c1",
      resourceUri: "ui://p/widget",
      title: "Widget",
    };
    expect(buildPluginUiSidePaneTabId(request)).toBe(
      "plugin-ui:%2Frepo:s1:p::ui%3A%2F%2Fp%2Fwidget:c1",
    );
    expect(buildPluginUiSidePaneTabId({ ...request, pluginId: "other" })).not.toBe(
      buildPluginUiSidePaneTabId(request),
    );
    const scope = { workspacePath: "/repo", sessionId: "s1", pluginId: "p" };
    const surface = { kind: "surface" as const, surfaceId: "panel" };
    expect(buildPluginUiSurfaceKey(scope, surface)).not.toBe(
      buildPluginUiSurfaceKey({ ...scope, pluginId: "other" }, surface),
    );
    expect(buildPluginUiSurfaceKey(scope, surface)).not.toBe(
      buildPluginUiSurfaceKey({ ...scope, workspaceIdentity: "ssh:a" }, surface),
    );
  });

  it("作用域解析：surfaceId 优先，两者都缺为 null", () => {
    expect(readPluginUiScopeRef({ toolCallId: "c1" })).toEqual({
      kind: "toolCall",
      toolCallId: "c1",
    });
    expect(readPluginUiScopeRef({ toolCallId: "c1", surfaceId: "p" })).toEqual({
      kind: "surface",
      surfaceId: "p",
    });
    expect(readPluginUiScopeRef({})).toBeNull();
  });

  it("示例请求生成 session 作用域的 tab", () => {
    const tab = exampleOpenSideTab({
      parentSessionId: "s1",
      toolCallId: "c1",
      pluginId: examplePresentation.pluginId,
      resourceUri: examplePresentation.resourceUri,
      title: "Widget",
      workspacePath: "/repo",
    });
    expect(tab.type).toBe("plugin-ui");
    expect(tab.id).toContain(":s1:");
    expect(tab.id).toContain(encodeURIComponent(examplePresentation.pluginId));
    expect(tab.remoteSessionId).toBeNull();
    const surfaceTab = exampleOpenSideTab({
      parentSessionId: "s1",
      surfaceId: "panel",
      serverName: examplePresentation.serverName,
      pluginId: examplePresentation.pluginId,
      resourceUri: examplePresentation.resourceUri,
      title: "Panel",
      workspacePath: "/repo",
    });
    expect(surfaceTab.id).toContain(":surface:panel");
    expect(surfaceTab.serverName).toBe(examplePresentation.serverName);
  });

  it("默认卡片高度符合宿主约定", () => {
    expect(PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX).toBe(240);
  });

  it("4a-0 / S3：会话动作只剩 sendFollowUp，命令端口是 sendText + uploadAttachment（widgetState 不再经会话命令）", () => {
    const port: PluginUiSessionCommandPort = {
      sendText: async () => "sent",
      uploadAttachment: async (input) => ({
        ref: "ref",
        fileName: input.fileName,
        mime: input.mime,
        bytes: 0,
      }),
    };
    const actions: PluginUiSessionActions = { sendFollowUp: async () => {} };
    expect(Object.keys(port)).toEqual(["sendText", "uploadAttachment"]);
    expect(Object.keys(actions)).toEqual(["sendFollowUp"]);
  });
});

function policyToolRow(
  rowId: number,
  turnId: string,
  status: ToolCallRow["status"] = "success",
  ui: Partial<PluginUiPresentation> = {},
): ToolCallRow {
  return {
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "mcp__fixture__edit",
    status,
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "fixture",
      toolName: "edit",
      ui: { pluginId: "fixture", resourceUri: "ui://fixture", ...ui },
    },
  };
}

function policyUserRow(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: "fixture",
  };
}

describe("plugin-ui turn membership contract", () => {
  it("counts non-plugin turns in first-seen order without promoting late rows from old turns", () => {
    const rows = [
      policyToolRow(1, "a"),
      policyUserRow(2, "b"),
      policyToolRow(3, "c"),
      policyUserRow(4, "d"),
      policyToolRow(5, "a", "success", { showInline: true }),
    ];
    const result = deriveLogicalUiInstances(rows);
    expect(result.byToolCallId["call-1"]?.autoExpand).toBe(false);
    expect(result.byToolCallId["call-3"]?.autoExpand).toBe(true);
    expect(result.byToolCallId["call-5"]).toMatchObject({
      autoExpand: false,
      forcedInline: true,
      superseded: false,
    });
    expect(
      deriveLogicalUiInstances(rows, { autoExpandTurns: 1 }).byToolCallId["call-3"]?.autoExpand,
    ).toBe(false);
    // Preserve existing slice(-0) semantics; this optimization does not change option boundaries.
    expect(
      deriveLogicalUiInstances(rows, { autoExpandTurns: 0 }).byToolCallId["call-1"]?.autoExpand,
    ).toBe(true);
  });

  it("preserves ordering and deduplication for prototype-like turn IDs", () => {
    const rows = ["__proto__", "constructor", "toString", "hasOwnProperty", "__proto__"].map(
      (turnId, index) => policyToolRow(index + 1, turnId),
    );
    const result = deriveLogicalUiInstances(rows);
    expect(rows.map((row) => result.byToolCallId[row.toolCallId]?.autoExpand)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("keeps the latest successful surface result when later calls fail or remain unfinished", () => {
    const shared = { surface: "panel" };
    const rows = [
      policyToolRow(1, "a", "success", shared),
      policyToolRow(2, "b", "success", { ...shared, isError: true }),
      policyToolRow(3, "c", "success", shared),
      policyToolRow(4, "d", "error", shared),
      policyToolRow(5, "e", "running", shared),
      policyToolRow(6, "f", "pendingApproval", shared),
      policyToolRow(7, "g", "cancelled", shared),
    ];
    const result = deriveLogicalUiInstances(rows);
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]).toMatchObject({
      activeToolCallId: "call-3",
      supersededToolCallIds: ["call-1"],
    });
    expect(rows.map((row) => result.byToolCallId[row.toolCallId]?.superseded)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it.each([false, true])("avoids repeated history membership scans (plugin UI: %s)", (pluginUi) => {
    const rows = Array.from({ length: 1500 }, (_, index) =>
      Object.freeze(
        pluginUi
          ? policyToolRow(index + 1, `performance-turn-${index}`)
          : policyUserRow(index + 1, `performance-turn-${index}`),
      ),
    );
    const includes = Array.prototype.includes;
    let membershipSearchWork = 0;
    const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (
      this: unknown[],
      value: unknown,
      fromIndex?: number,
    ) {
      if (typeof value === "string" && value.startsWith("performance-turn-"))
        membershipSearchWork += this.length;
      return includes.call(this, value, fromIndex);
    });
    let result;
    try {
      result = deriveLogicalUiInstances(Object.freeze(rows));
    } finally {
      spy.mockRestore();
    }
    if (pluginUi) {
      expect(result?.instances).toHaveLength(rows.length);
      expect(
        Object.values(result?.byToolCallId ?? {}).filter((row) => row.autoExpand),
      ).toHaveLength(3);
    } else {
      expect(result).toEqual({ instances: [], byToolCallId: {} });
    }
    // Bound membership-search work rather than wall time to avoid machine-dependent CI failures.
    expect(membershipSearchWork).toBeLessThanOrEqual(rows.length * 3);
  });
});
