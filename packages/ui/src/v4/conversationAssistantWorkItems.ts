import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isExecuteToolCall,
  isExploreToolCall,
  isShellToolCallAwaitingCommand,
} from "@/lib/exploreToolCall.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroups,
  type ConversationCuaGroupRenderItem,
} from "@/v4/conversationCuaGroups.js";

export type ConversationAssistantWorkRenderItem =
  | {
      kind: "row";
      key: string;
      row: AssistantWorkRow;
    }
  | {
      kind: "exploreGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | ConversationCuaGroupRenderItem
  | {
      kind: "executeGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "changesGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "agentToolCall";
      key: string;
      row: ToolCallRow;
      subagentRow: SubagentRow;
    };

export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export { ENABLE_CUA_TOOL_CALL_GROUPING } from "@/v4/conversationCuaGroups.js";
export const ENABLE_TERMINAL_TOOL_CALL_GROUPING = true;
export const ENABLE_CHANGES_TOOL_CALL_GROUPING = false;

export interface ConversationAssistantWorkRenderOptions {
  stageTailIsRunning?: boolean;
  enableCuaGrouping?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";

const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

function isExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExecuteToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family === "file-write";
}

function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function resolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  // Explore/Execute parent nodes represent the current work phase, not an aggregate of child-tool execution states.
  // Child tools may all have completed, but the parent phase continues until the current running work segment reaches the next visible boundary;
  // conversely, once later content outside the current group appears, the parent phase must end even if a child state is still running due to delay.
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

function buildExploreGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  // The group builder is called only after at least two consecutive tools of the same type; an empty array is invalid,
  // so do not hide caller errors behind a fabricated identity fallback.
  const firstRow = rows[0]!;
  const childToolCalls = rows.map(toolCallRowToLegacyNode);

  return {
    kind: "exploreGroup" as const,
    // The old key/toolId included the last row and count, so each new Explore child remounted the component
    // and made ToolLayout miss the expanded state the user had just saved under a new toolId. Anchor the aggregate identity to the first child tool;
    // update only children afterward to keep React identity and expanded-state identity stable as the stream grows.
    key: `explore:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `explore:${firstRow.toolCallId}`,
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls,
    },
  };
}

function buildExecuteGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "executeGroup" as const,
    // If group identity includes the last item or count, streaming commands remount the parent and lose expanded state.
    // As with Explore, anchor it to the first real tool call and update only children afterward.
    key: `execute:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `execute:${firstRow.toolCallId}`,
        toolName: "ExecuteGroup",
        kind: "executeGroup",
        title: "Execute",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function buildChangesGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "changesGroup" as const,
    // Changes expanded state must remain stable as Write/Edit items stream in, so anchor identity to the first tool.
    key: `changes:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `changes:${firstRow.toolCallId}`,
        toolName: "ChangesGroup",
        kind: "changesGroup",
        title: "Changes",
        input: {},
        // Changes is a UI phase container, not a real tool. Child failures/cancellations remain in their own details;
        // the parent reports only whether this phase remains at the end of the visible running segment.
        status: stageTailIsRunning ? "in_progress" : "completed",
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

/**
 * Agent tool rows and subagent rows must be paired by parentToolCallId exactly.
 *
 * Concurrent Agent tool-call rows in one turn appear in model-output order, while SubagentSpawned
 * events arrive in async scheduling order. The old FIFO paired one Agent's title with another's childSessionId.
 * Keep the unambiguous compatibility rule "the only remaining pair in the same turn" only for historical data missing the new field.
 */
function pairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (isAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(`${row.turnId}\0${row.toolCallId}`, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(`${row.turnId}\0${row.parentToolCallId}`);
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  for (const [turnId, subagentRows] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRows.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRows[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkRenderItem[] {
  const items: ConversationAssistantWorkRenderItem[] = [];
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableCuaGrouping = options?.enableCuaGrouping ?? ENABLE_CUA_TOOL_CALL_GROUPING;
  const enableTerminalGrouping =
    options?.enableTerminalGrouping ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING;
  const enableChangesGrouping = options?.enableChangesGrouping ?? ENABLE_CHANGES_TOOL_CALL_GROUPING;
  // Explore phase boundaries and tail status must use the order of rows actually visible to the user. If Shell rows waiting for a command
  // are skipped only inside the loop, they still occupy array positions and can make the preceding Explore appear finished;
  // hidden reasoning has the same issue. Remove all temporarily invisible rows first, then pair, group, and determine tail status.
  const visibleRows = rows.filter((row) => {
    if (
      row.kind === "reasoning" &&
      !isConversationReasoningRowVisible(row.rowId, reasoningVisibility)
    ) {
      return false;
    }
    return !shouldDeferUnclassifiedShellToolCall(row);
  });
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(visibleRows);
  const preparedRows = prepareCuaGroups(
    visibleRows,
    enableCuaGrouping,
    options?.stageTailIsRunning === true,
  );
  let index = 0;

  while (index < preparedRows.length) {
    const row = preparedRows[index];
    if (!row) {
      index += 1;
      continue;
    }

    if (row.kind === "cuaGroup") {
      items.push(row);
      index += 1;
      continue;
    }

    // A subagent row already paired into an Agent block is not rendered separately.
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) {
      index += 1;
      continue;
    }
    if (isToolCallRow(row)) {
      const pairedSubagent = subagentByAgentToolRowId.get(row.rowId);
      if (pairedSubagent) {
        items.push({
          kind: "agentToolCall",
          key: `agent:${row.rowId}`,
          row,
          subagentRow: pairedSubagent,
        });
        index += 1;
        continue;
      }
    }

    const isExploreRow = isExploreToolCallRow(row);
    if (!isExploreRow) {
      if (enableChangesGrouping && isChangesToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isChangesToolCallRow(nextRow)) break;
          groupRows.push(nextRow);
          index += 1;
        }
        // One tool does not need an extra UI composition layer; promote it to a parent group only when a second consecutive tool of the same type arrives.
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildChangesGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      if (enableTerminalGrouping && isExecuteToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isExecuteToolCallRow(nextRow)) {
            break;
          }
          groupRows.push(nextRow);
          index += 1;
        }
        // Preserve a single tool's own semantics/rendering instead of creating a Terminal container with only one child.
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildExecuteGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    if (!enableExploreGrouping) {
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    const groupRows: ToolCallRow[] = [row];
    index += 1;
    while (index < preparedRows.length) {
      const nextRow = preparedRows[index];
      if (!nextRow || nextRow.kind === "cuaGroup" || !isExploreToolCallRow(nextRow)) {
        break;
      }
      groupRows.push(nextRow);
      index += 1;
    }
    // Explore is formed only after a second consecutive read-only tool appears; show the first one immediately as its original tool.
    if (groupRows.length === 1) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      continue;
    }
    items.push(
      buildExploreGroup(
        groupRows,
        options?.stageTailIsRunning === true && index === preparedRows.length,
      ),
    );
  }

  return items;
}
