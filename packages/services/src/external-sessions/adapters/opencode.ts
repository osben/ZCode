import { join } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  buildSummary,
  capTranscript,
  homeDirs,
  isRecord,
  pathExists,
  readString,
  toTimestampMs,
  titleFromPrompt,
  withReadOnlySqlite,
  type JsonRecord,
} from "#src/external-sessions/adapters/shared.js";
import type {
  ExternalSessionScanContext,
  ExternalSessionSourceAdapter,
  ExternalSessionTranscriptRead,
} from "#src/external-sessions/adapters/types.js";
import type {
  ExternalSessionSummary,
  ExternalSessionTranscriptMessage,
} from "#src/external-sessions/contract.js";

/** One row as node:sqlite returns it; every column read must narrow the value type. */
type DbRow = Record<string, SQLOutputValue>;

/**
 * OpenCode (specs/external-sessions.md "Sources"). One SQLite store per home at
 * `<home>/.local/share/opencode/opencode.db`, opened strictly read-only. Two schemas:
 * the current `session_v2` + `session_message` store, and the legacy
 * `session` + `message` + `part` store; both are probed per database.
 */
export const opencodeSessionsAdapter: ExternalSessionSourceAdapter = {
  source: "opencode",
  list: listOpencodeSessions,
  readTranscript: readOpencodeTranscript,
};

function opencodeDbPath(home: string): string {
  return join(home, ".local", "share", "opencode", "opencode.db");
}

async function listOpencodeSessions(
  ctx: ExternalSessionScanContext,
): Promise<ExternalSessionSummary[]> {
  const byId = new Map<string, ExternalSessionSummary>();
  for (const home of homeDirs(ctx)) {
    const dbPath = opencodeDbPath(home);
    if (!(await pathExists(dbPath))) continue;
    // The store exists; an open failure means the source is unavailable and must throw.
    const summaries = withReadOnlySqlite(dbPath, (db) => listFromDatabase(ctx, db, dbPath));
    // The sqlite callback is synchronous, so the cwd existence probe runs after it closes.
    for (const summary of summaries) {
      summary.workspaceMissing = !(await pathExists(summary.workspacePath));
      // The same home may be probed twice (homeDir plus extraHomeDirs); keep the first hit.
      if (!byId.has(summary.sessionId)) byId.set(summary.sessionId, summary);
    }
  }
  return [...byId.values()];
}

function listFromDatabase(
  ctx: ExternalSessionScanContext,
  db: DatabaseSync,
  dbPath: string,
): ExternalSessionSummary[] {
  const tables = tableNames(db);
  if (tables.has("session_v2")) return listV2Sessions(ctx, db, dbPath);
  if (tables.has("session") && tables.has("message") && tables.has("part")) {
    return listLegacySessions(ctx, db, dbPath);
  }
  // A database that is neither schema is a format drift; treat the source as unavailable.
  throw new Error(`opencode: unrecognized schema in ${dbPath}`);
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows: DbRow[] = db.prepare("select name from sqlite_master where type = 'table'").all();
  return new Set(rows.map((row) => String(row.name)));
}

function rowString(row: DbRow, key: string): string | undefined {
  return readString(row[key]);
}

function rowTimestamp(row: DbRow, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "bigint") return toTimestampMs(Number(value));
  return toTimestampMs(value);
}

/** `model` column: JSON text like {"id":"...","providerID":"..."}; renders as `providerID/id`. */
function parseModelText(value: SQLOutputValue | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return formatModelRecord(parseDataRecord(value));
}

function formatModelRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;
  const providerId = readString(value.providerID);
  return providerId ? `${providerId}/${id}` : id;
}

function parseDataRecord(value: SQLOutputValue | undefined): JsonRecord | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// --- Current schema: session_v2 + project + session_message ---

function listV2Sessions(
  ctx: ExternalSessionScanContext,
  db: DatabaseSync,
  dbPath: string,
): ExternalSessionSummary[] {
  const rows: DbRow[] = db
    .prepare(
      `select s.id as id, s.directory as directory, s.title as title, s.model as model,
              s.time_created as time_created, s.time_updated as time_updated, p.worktree as worktree
       from session_v2 s left join project p on p.id = s.project_id
       where s.parent_id is null`,
    )
    .all();
  // One grouped query keeps listing O(1) per session instead of O(sessions) count queries.
  const counts = messageCounts(db, "session_message", "type");
  const summaries: ExternalSessionSummary[] = [];
  for (const row of rows) {
    const sessionId = rowString(row, "id");
    if (!sessionId) {
      ctx.warn(`opencode: session_v2 row without id in ${dbPath}`);
      continue;
    }
    const workspacePath = rowString(row, "directory") ?? rowString(row, "worktree");
    if (!workspacePath) {
      ctx.warn(`opencode: session ${sessionId} has no directory or project worktree`);
      continue;
    }
    const updatedAt = rowTimestamp(row, "time_updated") ?? rowTimestamp(row, "time_created");
    const createdAt = rowTimestamp(row, "time_created") ?? updatedAt;
    if (updatedAt === undefined) {
      ctx.warn(`opencode: session ${sessionId} has no usable timestamps`);
      continue;
    }
    const title = rowString(row, "title") ?? v2TitleFromFirstUserMessage(db, sessionId);
    summaries.push(
      buildSummary({
        source: "opencode",
        sessionId,
        workspacePath,
        // Placeholder; listOpencodeSessions patches it once the sqlite callback has returned.
        workspaceMissing: false,
        title,
        createdAt,
        updatedAt,
        model: parseModelText(row.model),
        messageCount: counts.get(sessionId),
        sourcePath: dbPath,
        transcriptAvailable: true,
      }),
    );
  }
  return summaries;
}

/** Cheap title fallback: the first user message text, via the (session_id, seq) index order. */
function v2TitleFromFirstUserMessage(db: DatabaseSync, sessionId: string): string | undefined {
  const row = db
    .prepare(
      "select data from session_message where session_id = ? and type = 'user' order by seq limit 1",
    )
    .get(sessionId);
  if (!row) return undefined;
  return titleFromPrompt(readString(parseDataRecord(row.data)?.text));
}

// --- Legacy schema: session + message + part ---

function listLegacySessions(
  ctx: ExternalSessionScanContext,
  db: DatabaseSync,
  dbPath: string,
): ExternalSessionSummary[] {
  const withProject = tableNames(db).has("project");
  const rows: DbRow[] = db
    .prepare(
      withProject
        ? `select s.id as id, s.directory as directory, s.title as title,
                  s.time_created as time_created, s.time_updated as time_updated, p.worktree as worktree
           from session s left join project p on p.id = s.project_id`
        : `select s.id as id, s.directory as directory, s.title as title,
                  s.time_created as time_created, s.time_updated as time_updated, null as worktree
           from session s`,
    )
    .all();
  const counts = messageCounts(db, "message", "role");
  const summaries: ExternalSessionSummary[] = [];
  for (const row of rows) {
    const sessionId = rowString(row, "id");
    if (!sessionId) {
      ctx.warn(`opencode: legacy session row without id in ${dbPath}`);
      continue;
    }
    const workspacePath = rowString(row, "directory") ?? rowString(row, "worktree");
    if (!workspacePath) {
      ctx.warn(`opencode: legacy session ${sessionId} has no directory or project worktree`);
      continue;
    }
    const updatedAt = rowTimestamp(row, "time_updated") ?? rowTimestamp(row, "time_created");
    const createdAt = rowTimestamp(row, "time_created") ?? updatedAt;
    if (updatedAt === undefined) {
      ctx.warn(`opencode: legacy session ${sessionId} has no usable timestamps`);
      continue;
    }
    summaries.push(
      buildSummary({
        source: "opencode",
        sessionId,
        workspacePath,
        // Placeholder; listOpencodeSessions patches it once the sqlite callback has returned.
        workspaceMissing: false,
        title: rowString(row, "title") ?? legacyTitleFromFirstUserMessage(db, sessionId),
        createdAt,
        updatedAt,
        messageCount: counts.get(sessionId),
        sourcePath: dbPath,
        transcriptAvailable: true,
      }),
    );
  }
  return summaries;
}

function legacyTitleFromFirstUserMessage(db: DatabaseSync, sessionId: string): string | undefined {
  const row = db
    .prepare(
      `select pt.text as text from message m
       join part pt on pt.message_id = m.id and pt.type = 'text'
       where m.session_id = ? and m.role = 'user'
       order by m.time_created, m.rowid, pt.rowid limit 1`,
    )
    .get(sessionId);
  return titleFromPrompt(row ? readString(row.text) : undefined);
}

function messageCounts(db: DatabaseSync, table: string, typeColumn: string): Map<string, number> {
  const rows: DbRow[] = db
    .prepare(
      `select session_id, count(*) as count
       from ${table} where ${typeColumn} in ('user','assistant') group by session_id`,
    )
    .all();
  return new Map(rows.map((row) => [String(row.session_id), Number(row.count)]));
}

// --- Transcripts ---

async function readOpencodeTranscript(
  ctx: ExternalSessionScanContext,
  summary: ExternalSessionSummary,
): Promise<ExternalSessionTranscriptRead | null> {
  // The summary may be stale; re-locate the store from its own sourcePath.
  const dbPath = summary.sourcePath || opencodeDbPath(ctx.homeDir);
  if (!(await pathExists(dbPath))) return null;
  return withReadOnlySqlite(dbPath, (db) => {
    const tables = tableNames(db);
    if (tables.has("session_v2")) return v2Transcript(db, summary.sessionId);
    if (tables.has("session") && tables.has("message") && tables.has("part")) {
      return legacyTranscript(db, summary.sessionId);
    }
    return null;
  });
}

function v2Transcript(db: DatabaseSync, sessionId: string): ExternalSessionTranscriptRead | null {
  const exists = db.prepare("select 1 from session_v2 where id = ?").get(sessionId);
  if (!exists) return null;
  const rows = db
    .prepare(
      `select type, data, time_created from session_message
       where session_id = ? and type in ('user','assistant') order by seq`,
    )
    .all(sessionId);
  const messages: ExternalSessionTranscriptMessage[] = [];
  for (const row of rows) {
    const data = parseDataRecord(row.data);
    const timestamp =
      toTimestampMs(readTimeCreated(data?.time)) ?? rowTimestamp(row, "time_created");
    if (row.type === "user") {
      const text = readString(data?.text);
      if (text) messages.push({ role: "user", text, ...(timestamp ? { timestamp } : {}) });
      continue;
    }
    // Assistant rows carry a content array; only text parts are transcript material.
    const content = data?.content;
    if (!Array.isArray(content)) continue;
    const parts = content
      .filter((item): item is JsonRecord => isRecord(item) && item.type === "text")
      .map((item) => readString(item.text))
      .filter((text): text is string => Boolean(text));
    if (parts.length === 0) continue;
    const model = formatModelRecord(data?.model);
    messages.push({
      role: "assistant",
      text: parts.join("\n\n"),
      ...(timestamp ? { timestamp } : {}),
      ...(model ? { model } : {}),
    });
  }
  return capTranscript(messages);
}

function legacyTranscript(
  db: DatabaseSync,
  sessionId: string,
): ExternalSessionTranscriptRead | null {
  const exists = db.prepare("select 1 from session where id = ?").get(sessionId);
  if (!exists) return null;
  const rows = db
    .prepare(
      `select m.id as message_id, m.role as role, m.time_created as time_created, pt.text as text
       from message m join part pt on pt.message_id = m.id and pt.type = 'text'
       where m.session_id = ? and m.role in ('user','assistant')
       order by m.time_created, m.rowid, pt.rowid`,
    )
    .all(sessionId);
  const messages: ExternalSessionTranscriptMessage[] = [];
  let currentId: string | undefined;
  let currentRole: "user" | "assistant" | undefined;
  let currentTimestamp: number | undefined;
  let currentParts: string[] = [];
  const flush = (): void => {
    if (currentId && currentRole && currentParts.length > 0) {
      messages.push({
        role: currentRole,
        text: currentParts.join("\n\n"),
        ...(currentTimestamp ? { timestamp: currentTimestamp } : {}),
      });
    }
    currentParts = [];
  };
  for (const row of rows) {
    const messageId = String(row.message_id);
    if (messageId !== currentId) {
      flush();
      currentId = messageId;
      currentRole = row.role === "assistant" ? "assistant" : "user";
      currentTimestamp = rowTimestamp(row, "time_created");
    }
    const text = readString(row.text);
    if (text) currentParts.push(text);
  }
  flush();
  return capTranscript(messages);
}

function readTimeCreated(value: unknown): unknown {
  return isRecord(value) ? value.created : undefined;
}
