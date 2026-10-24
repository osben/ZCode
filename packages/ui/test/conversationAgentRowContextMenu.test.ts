// @vitest-environment jsdom
// Agent row context menu (specs/conversation-agent-row-context-menu.md): Trajectory opens the
// child's model trajectory v2 tab, Copy session ID copies the child id; remote workspaces, phones,
// rows without a child and rows with a text selection keep the native menu.
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";

const viewport = vi.hoisted(() => ({ mobile: false }));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/mobileTextInput.js", () => ({
  useIsMobileTextInputViewport: () => viewport.mobile,
}));
vi.mock("@/ToolCallBlocks.js", () => ({
  ToolCallBlock: () => createElement("span", null, "Agent row body"),
}));
vi.mock("@/ToolCallBlocks/renderers/agentHelpers.js", () => ({
  getAgentPrimaryText: () => "Study CLI runtime",
}));
vi.mock("@/v4/toolCallRowAdapter.js", () => ({
  toolCallRowToLegacyNode: () => ({ toolCall: { toolId: "tc-1", toolName: "Agent" } }),
}));
vi.mock("@/v4/telemetry/ConversationTelemetryAttachment.js", () => ({
  useScopedConversationTelemetrySupervisor: () => null,
}));

function item(childSessionId?: string) {
  return {
    kind: "agentToolCall",
    row: { rowId: "r1", toolCallId: "tc-1" },
    subagentRow: {
      status: "completed",
      startedAt: 1_000,
      endedAt: 6_000,
      subagentType: "Explore",
      ...(childSessionId ? { childSessionId } : {}),
    },
  } as never;
}

function renderRow(options: { childSessionId?: string; context?: Record<string, unknown> } = {}) {
  const context = { workspacePath: "/w", sessionId: "parent", ...options.context } as never;
  return render(
    createElement(ConversationAgentToolCallRow, {
      item: item("childSessionId" in options ? options.childSessionId : "child-1"),
      context,
    }),
  );
}

const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  viewport.mobile = false;
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useModelTrajectoryStore.setState({ pendingRequest: null });
});

afterEach(() => {
  cleanup();
  writeText.mockClear();
  window.getSelection()?.removeAllRanges();
});

describe("Agent row context menu", () => {
  it("opens the child's trajectory v2 tab and copies the child session id", async () => {
    renderRow();
    fireEvent.contextMenu(screen.getByText("Agent row body"));
    fireEvent.click(await screen.findByText("taskList.viewModelTrajectoryV2"));
    expect(useModelTrajectoryStore.getState().pendingRequest).toMatchObject({
      taskId: "child-1",
      workspaceKey: "/w",
      title: "Study CLI runtime",
      kind: "v2",
    });

    fireEvent.contextMenu(screen.getByText("Agent row body"));
    fireEvent.click(await screen.findByText("appHeader.copySessionId"));
    expect(writeText).toHaveBeenCalledWith("child-1");
  });

  it.each([
    ["a remote workspace identity", { context: { workspaceIdentity: "remote:server:s:/w" } }],
    ["a remote session", { context: { workspaceRemoteSessionId: "remote-1" } }],
    ["a row without a child session", { childSessionId: undefined }],
  ])("keeps the native menu for %s", (_label, options) => {
    renderRow(options);
    fireEvent.contextMenu(screen.getByText("Agent row body"));
    expect(screen.queryByText("taskList.viewModelTrajectoryV2")).toBeNull();
  });

  it("keeps the native menu on phones", () => {
    viewport.mobile = true;
    renderRow();
    fireEvent.contextMenu(screen.getByText("Agent row body"));
    expect(screen.queryByText("taskList.viewModelTrajectoryV2")).toBeNull();
  });

  it("keeps the native menu while text inside the row is selected", () => {
    renderRow();
    const body = screen.getByText("Agent row body");
    const range = document.createRange();
    range.selectNodeContents(body);
    window.getSelection()?.addRange(range);
    fireEvent.pointerDown(body, { button: 2 });
    fireEvent.contextMenu(body);
    expect(screen.queryByText("taskList.viewModelTrajectoryV2")).toBeNull();
  });
});
