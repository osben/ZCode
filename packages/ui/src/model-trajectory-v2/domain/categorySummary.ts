import type { ZCodeModelTrajectoryV2 } from "../contract.js";
import { classifyToolCall, collectMemoryRoots, type EventCategory } from "./eventCategories.js";
import type { LedgerRow } from "./ledger.js";

/** The category a ledger row belongs to, if any. */
export function rowCategory(row: LedgerRow): EventCategory | undefined {
  if (row.kind === "tool") return row.category?.category;
  if (row.kind === "context") return "memory";
  if (
    row.kind === "marker" &&
    (row.marker === "memory-dream" || row.marker === "memory-recall-selection")
  ) {
    return "memory";
  }
  return undefined;
}

/** Rows of one category; turn headers stay when one of their rows is kept, request separators are dropped. */
export function filterRowsByCategory(rows: readonly LedgerRow[], category: EventCategory | null) {
  if (!category) return [...rows];
  const kept: LedgerRow[] = [];
  let pendingTurn: LedgerRow | undefined;
  for (const row of rows) {
    if (row.kind === "turn") {
      pendingTurn = row;
      continue;
    }
    if (rowCategory(row) !== category) continue;
    if (pendingTurn) {
      kept.push(pendingTurn);
      pendingTurn = undefined;
    }
    kept.push(row);
  }
  return kept;
}

export interface CategorySummary {
  skills: { name: string; calls: number }[];
  skillCalls: number;
  memoryReads: number;
  memoryWrites: number;
  memorySidecars: number;
  mcpServers: { server: string; calls: number; execMs: number }[];
  mcpCalls: number;
}

/**
 * Totals over the whole loaded window, including hidden sidecar records (a dream call's memory writes count). Context
 * injections are counted from the ledger rows, which already scan only new input.
 */
export function summarizeCategories(
  trajectory: Pick<ZCodeModelTrajectoryV2, "records" | "toolTiming">,
  rows: readonly LedgerRow[],
): CategorySummary {
  const memoryRoots = collectMemoryRoots(trajectory.records);
  const execById = new Map(
    trajectory.toolTiming.entries.map((entry) => [entry.toolCallId, entry.execDurationMs ?? 0]),
  );
  const skills = new Map<string, number>();
  const servers = new Map<string, { server: string; calls: number; execMs: number }>();
  let memoryReads = 0;
  let memoryWrites = 0;
  let skillCalls = 0;
  let mcpCalls = 0;
  for (const record of trajectory.records) {
    for (const part of record.response?.toolCalls ?? []) {
      if (part.kind !== "tool-call") continue;
      const info = classifyToolCall({ toolName: part.toolName, args: part.input, memoryRoots });
      if (!info) continue;
      if (info.skill) {
        skillCalls += 1;
        skills.set(info.skill.name, (skills.get(info.skill.name) ?? 0) + 1);
      } else if (info.mcp) {
        mcpCalls += 1;
        const entry = servers.get(info.mcp.server) ?? {
          server: info.mcp.server,
          calls: 0,
          execMs: 0,
        };
        entry.calls += 1;
        entry.execMs += part.toolCallId ? (execById.get(part.toolCallId) ?? 0) : 0;
        servers.set(info.mcp.server, entry);
      } else if (info.memory?.op === "write") {
        memoryWrites += 1;
      } else if (info.memory) {
        memoryReads += 1;
      }
    }
  }
  memoryReads += rows.filter((row) => row.kind === "context").length;
  return {
    skills: [...skills].map(([name, calls]) => ({ name, calls })),
    skillCalls,
    memoryReads,
    memoryWrites,
    memorySidecars: rows.filter(
      (row) =>
        row.kind === "marker" &&
        (row.marker === "memory-dream" || row.marker === "memory-recall-selection"),
    ).length,
    mcpServers: [...servers.values()].sort(
      (a, b) => b.calls - a.calls || a.server.localeCompare(b.server),
    ),
    mcpCalls,
  };
}
