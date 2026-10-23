import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolveAgentSessionDbPath } from "#src/onboarding/localUsageEvidence.js";
import type { ToolTimingPort, ZCodeTrajectoryV2ToolTimingResult } from "../contract.js";
import { toToolTimings } from "../domain/toolTiming.js";
import type { UnknownRecord } from "../domain/values.js";

const CHUNK_SIZE = 500;
const COLUMNS =
  "tool_call_id, tool_name, status, approval_status, turn_id, started_at, completed_at, duration_ms, error_type";

export interface SqliteToolTimingOptions {
  /** Overrides the CLI session database path resolution (tests). */
  resolveDbPath?: () => Promise<string | null>;
}

/**
 * Read-only lookup of the CLI's `tool_usage` rows. The CLI owns the database; this adapter never writes it, opens it
 * read-only with a short busy timeout, and turns every failure into `unavailable` so the trajectory still loads.
 * node:sqlite has only a synchronous API; the query is bounded by the (session_id, tool_call_id) unique index.
 */
export function createSqliteToolTimingPort(options: SqliteToolTimingOptions = {}): ToolTimingPort {
  const resolveDbPath = options.resolveDbPath ?? (() => resolveAgentSessionDbPath());
  return {
    async read(taskId, toolCallIds): Promise<ZCodeTrajectoryV2ToolTimingResult> {
      let dbPath: string | null;
      try {
        dbPath = await resolveDbPath();
      } catch {
        return { source: "unavailable", reason: "read-failed", entries: [] };
      }
      if (!dbPath) return { source: "unavailable", reason: "db-path-unknown", entries: [] };
      try {
        await stat(dbPath);
      } catch {
        return { source: "unavailable", reason: "db-missing", entries: [] };
      }
      if (toolCallIds.length === 0) return { source: "session-db", entries: [] };
      try {
        return {
          source: "session-db",
          entries: toToolTimings(queryRows(dbPath, taskId, toolCallIds)),
        };
      } catch {
        return { source: "unavailable", reason: "read-failed", entries: [] };
      }
    },
  };
}

function queryRows(
  dbPath: string,
  taskId: string,
  toolCallIds: readonly string[],
): UnknownRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 250");
    const rows: UnknownRecord[] = [];
    for (let start = 0; start < toolCallIds.length; start += CHUNK_SIZE) {
      const chunk = toolCallIds.slice(start, start + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const statement = db.prepare(
        `SELECT ${COLUMNS} FROM tool_usage WHERE session_id = ? AND tool_call_id IN (${placeholders})`,
      );
      rows.push(...(statement.all(taskId, ...chunk) as UnknownRecord[]));
    }
    return rows;
  } finally {
    db.close();
  }
}
