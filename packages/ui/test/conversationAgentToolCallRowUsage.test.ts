// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  buildSubagentUsageSessionKey,
  recordSubagentToolAttribution,
  resetMessageTelemetryForTest,
} from "@/lib/messageTelemetry.js";
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";

const captured = vi.hoisted(() => ({ summary: null as ReactNode, version: "" }));

vi.mock("@/ToolCallBlocks.js", () => ({
  ToolCallBlock: (props: { agentUsageSummary?: ReactNode; agentUsageSummaryVersion?: string }) => {
    captured.summary = props.agentUsageSummary ?? null;
    captured.version = props.agentUsageSummaryVersion ?? "";
    return null;
  },
}));

vi.mock("@/v4/toolCallRowAdapter.js", () => ({
  toolCallRowToLegacyNode: () => ({ toolCall: { toolId: "tc-1", toolName: "Agent" } }),
}));

vi.mock("@/v4/telemetry/ConversationTelemetryAttachment.js", () => ({
  useScopedConversationTelemetrySupervisor: () => ({
    getSubagentUsageSessionKey: (sessionId: string) =>
      buildSubagentUsageSessionKey("scope", sessionId),
  }),
}));

const item = {
  kind: "agentToolCall",
  row: { rowId: "r1", toolCallId: "tc-1" },
  subagentRow: { status: "completed", startedAt: 1_000, endedAt: 6_000, subagentType: "general" },
} as never;
const context = { workspacePath: "/w", sessionId: "s1" } as never;

function renderRow() {
  return render(
    createElement(
      ZCodeIntlProvider,
      null,
      createElement(ConversationAgentToolCallRow, { item, context }),
    ),
  );
}

describe("ConversationAgentToolCallRow inline usage", () => {
  afterEach(() => {
    cleanup();
    resetMessageTelemetryForTest();
    captured.summary = null;
    captured.version = "";
  });

  it("shows elapsed time only before any provider usage report", () => {
    renderRow();
    expect(captured.version).toMatch(/^:::/);
    expect(captured.summary).not.toBeNull();
  });

  it("updates counts when the supervisor publishes cumulative usage for the same tool call", () => {
    renderRow();
    act(() => {
      recordSubagentToolAttribution({
        taskId: "task",
        usageSessionKey: buildSubagentUsageSessionKey("scope", "s1"),
        toolCallId: "tc-1",
        requestIds: ["a"],
        requestCount: 1,
        modelName: "m",
        usage: { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 },
      } as never);
    });
    expect(captured.version).toContain("1200:30:1230");
  });
});
