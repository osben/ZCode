import type {
  ConversationRow,
  ConversationRowsPartition,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { resolvePluginUiLogicalScope } from "./pluginUiLogicalScope.js";

/** Plugin cards from the most recent turns are expanded by default; earlier ones collapse into the folded area. */
export const PLUGIN_UI_AUTO_EXPAND_TURNS = 3;

/** One logical UI: merged only for an explicit surface or widgets whose permission scope is identical; other calls stay independent. */
export interface PluginUiLogicalInstance {
  key: string;
  /** Currently displayed call: the latest successful (non-isError) one; with no success, the latest row. */
  activeToolCallId: string;
  /** Successful calls superseded by a newer success; they create no sandbox and stay as plain tool records. */
  supersededToolCallIds: string[];
}

/** Display disposition for a single plugin tool row; the render layer decides folding and sandbox creation from it. */
export interface PluginUiRowDisposition {
  key: string;
  superseded: boolean;
  /** The row's turn is within the last PLUGIN_UI_AUTO_EXPAND_TURNS turns. */
  autoExpand: boolean;
  /** Tool-level `openai/widgetShowCodexWidgetInline` (display.ui.showInline). */
  forcedInline: boolean;
}

export interface PluginUiInstanceDerivation {
  instances: PluginUiLogicalInstance[];
  byToolCallId: Readonly<Record<string, PluginUiRowDisposition>>;
}

export const EMPTY_PLUGIN_UI_INSTANCE_DERIVATION: PluginUiInstanceDerivation = {
  instances: [],
  byToolCallId: {},
};

function isPluginUiToolRow(row: ConversationRow): row is ToolCallRow {
  return (
    row.kind === "toolCall" && row.display?.kind === "mcp_tool" && row.display.ui !== undefined
  );
}

function isSuccessfulUiRow(row: ToolCallRow): boolean {
  return (
    row.status === "success" &&
    !(row.display?.kind === "mcp_tool" && row.display.ui?.isError === true)
  );
}

/**
 * Pure function: derives logical UI instances and per-row display dispositions from projection rows (V-a).
 * The key binds source, server, resource, permissions, and logical view together; within the same key the
 * newest successful result supersedes earlier successes, while running / failed / isError rows neither
 * supersede others nor are superseded (each shows its own state).
 * autoExpand takes the most recent N turns across all rows in turn order (a turn without plugin cards
 * still counts as a turn).
 */
export function deriveLogicalUiInstances(
  rows: readonly ConversationRow[],
  options: { autoExpandTurns?: number } = {},
): PluginUiInstanceDerivation {
  // Domain constraints prohibit Map/Set; use arrays and plain objects instead.
  const turnOrder: string[] = [];
  // Repeated includes scans make history deduplication quadratic; a null-prototype index keeps it linear.
  const seenTurns: Record<string, true | undefined> = Object.create(null);
  for (const row of rows) {
    if (!seenTurns[row.turnId]) {
      seenTurns[row.turnId] = true;
      turnOrder.push(row.turnId);
    }
  }
  const recentTurns = Object.fromEntries(
    turnOrder
      .slice(-(options.autoExpandTurns ?? PLUGIN_UI_AUTO_EXPAND_TURNS))
      .map((id) => [id, true]),
  );
  const groupKeys: string[] = [];
  const groups: Record<string, ToolCallRow[]> = {};
  for (const row of rows) {
    if (!isPluginUiToolRow(row)) continue;
    const display = row.display;
    if (display?.kind !== "mcp_tool" || !display.ui) continue;
    const logical = resolvePluginUiLogicalScope(display.ui, {
      kind: "toolCall",
      toolCallId: row.toolCallId,
    });
    const key = JSON.stringify([
      display.ui.pluginId,
      display.serverName,
      display.ui.resourceUri,
      logical,
    ]);
    const group = groups[key];
    if (group) group.push(row);
    else {
      groups[key] = [row];
      groupKeys.push(key);
    }
  }
  const instances: PluginUiLogicalInstance[] = [];
  const byToolCallId: Record<string, PluginUiRowDisposition> = {};
  for (const key of groupKeys) {
    const group = groups[key]!;
    const successes = group.filter(isSuccessfulUiRow);
    const active = successes.at(-1) ?? group.at(-1)!;
    const superseded = successes.filter((row) => row !== active).map((row) => row.toolCallId);
    const supersededById = Object.fromEntries(superseded.map((id) => [id, true]));
    instances.push({ key, activeToolCallId: active.toolCallId, supersededToolCallIds: superseded });
    for (const row of group) {
      byToolCallId[row.toolCallId] = {
        key,
        superseded: Object.hasOwn(supersededById, row.toolCallId),
        autoExpand: Object.hasOwn(recentTurns, row.turnId),
        forcedInline: row.display?.kind === "mcp_tool" && row.display.ui?.showInline === true,
      };
    }
  }
  return { instances, byToolCallId };
}

function sameRefs<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * deriveLogicalUiInstances reads only plugin UI rows and the turn order of all rows.
 *
 * Bug cause: the timeline re-derives over all rows every frame, so streaming in long sessions costs grow linearly with history length.
 * The caller passes a "history + tail turns" partition matching rows (the two turn ranges are disjoint, see
 * docs/ui/chat-virtual-scroll.md "per-frame derivation cost"): when the history segment reference is unchanged and the tail turn sequence and plugin UI
 * row references are also unchanged, the derivation input is identical and the previous result is reused; otherwise the whole window is re-derived.
 */
export function createLogicalUiInstancesSelector() {
  let previous: {
    history: readonly ConversationRow[];
    tailTurnIds: string[];
    tailUiRows: ToolCallRow[];
    result: PluginUiInstanceDerivation;
  } | null = null;
  return (
    rows: readonly ConversationRow[],
    partition: ConversationRowsPartition,
  ): PluginUiInstanceDerivation => {
    const tailTurnIds: string[] = [];
    const tailUiRows: ToolCallRow[] = [];
    for (const row of partition.tail) {
      if (!tailTurnIds.includes(row.turnId)) tailTurnIds.push(row.turnId);
      if (isPluginUiToolRow(row)) tailUiRows.push(row);
    }
    if (
      previous?.history === partition.history &&
      sameRefs(previous.tailTurnIds, tailTurnIds) &&
      sameRefs(previous.tailUiRows, tailUiRows)
    ) {
      return previous.result;
    }
    const result = deriveLogicalUiInstances(rows);
    previous = { history: partition.history, tailTurnIds, tailUiRows, result };
    return result;
  };
}
