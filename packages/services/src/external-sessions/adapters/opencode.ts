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
 * Most recently updated root sessions listed per store. The listing runs synchronously on the Host event loop,
 * so one scan is bounded by this page instead of the whole store (specs/external-sessions.md "Scan cost").
 */
const OPENCODE_LIST_LIMIT = 500;

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
    const summaries = await withReadOnlySqlite(dbPath, (db) => listFromDatabase(ctx, db, dbPath));
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
  // session_v2 / assistant parts use `id`; legacy message data uses `modelID`.
  const id = readString(value.id) ?? readString(value.modelID);
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
       where s.parent_id is null
       order by s.time_updated desc limit ?`,
    )
    .all(OPENCODE_LIST_LIMIT);
  // One indexed query for the page's counts; the listing never scans the whole message table.
  const counts = messageCounts(
    db,
    "session_message",
    "type",
    rows.map((row) => String(row.id)),
  );
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

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * Legacy store (OpenCode ≤ 1.x `session.sql.ts`): `message.data` and `part.data` are JSON documents
 * (`{"role":"user",...}` / `{"type":"text","text":"..."}`); there are no standalone role/type/text columns.
 */
function listLegacySessions(
  ctx: ExternalSessionScanContext,
  db: DatabaseSync,
  dbPath: string,
): ExternalSessionSummary[] {
  const sessionColumns = tableColumns(db, "session");
  const withProject = tableNames(db).has("project");
  const modelSelect = sessionColumns.has("model") ? "s.model as model" : "null as model";
  const worktreeSelect = withProject ? "p.worktree as worktree" : "null as worktree";
  const projectJoin = withProject ? "left join project p on p.id = s.project_id" : "";
  // Child sessions (parent_id) are subagent/fork children in the legacy store too.
  const whereClause = sessionColumns.has("parent_id") ? "where s.parent_id is null" : "";
  const rows = db
    .prepare(
      `select s.id as id, s.directory as directory, s.title as title, ${modelSelect},
              s.time_created as time_created, s.time_updated as time_updated, ${worktreeSelect}
       from session s ${projectJoin} ${whereClause}
       order by s.time_updated desc limit ?`,
    )
    .all(OPENCODE_LIST_LIMIT) as DbRow[];
  const counts = messageCounts(
    db,
    "message",
    "json_extract(data, '$.role')",
    rows.map((row) => String(row.id)),
  );
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
        model: parseModelText(row.model),
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
      `select pt.data as part_data from message m
       join part pt on pt.message_id = m.id and json_extract(pt.data, '$.type') = 'text'
       where m.session_id = ? and json_extract(m.data, '$.role') = 'user'
       order by m.time_created, m.id, pt.time_created, pt.id limit 1`,
    )
    .get(sessionId) as DbRow | undefined;
  return titleFromPrompt(row ? readString(parseDataRecord(row.part_data)?.text) : undefined);
}

/**
 * Counts user/assistant messages for the given sessions only (the listed page), so the cost follows the
 * page size instead of the size of the whole message table.
 */
function messageCounts(
  db: DatabaseSync,
  table: string,
  typeColumn: string,
  sessionIds: readonly string[],
): Map<string, number> {
  if (sessionIds.length === 0) return new Map();
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows: DbRow[] = db
    .prepare(
      `select session_id, count(*) as count
       from ${table} where ${typeColumn} in ('user','assistant') and session_id in (${placeholders})
       group by session_id`,
    )
    .all(...sessionIds);
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
  return withReadOnlySqlite(dbPath, (db): ExternalSessionTranscriptRead | null => {
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
      `select m.id as message_id, m.data as message_data, m.time_created as time_created, pt.data as part_data
       from message m join part pt on pt.message_id = m.id and json_extract(pt.data, '$.type') = 'text'
       where m.session_id = ? and json_extract(m.data, '$.role') in ('user','assistant')
       order by m.time_created, m.id, pt.time_created, pt.id`,
    )
    .all(sessionId) as DbRow[];
  const messages: ExternalSessionTranscriptMessage[] = [];
  let currentId: string | undefined;
  let currentRole: "user" | "assistant" | undefined;
  let currentTimestamp: number | undefined;
  let currentModel: string | undefined;
  let currentParts: string[] = [];
  const flush = (): void => {
    if (currentId && currentRole && currentParts.length > 0) {
      messages.push({
        role: currentRole,
        text: currentParts.join("\n\n"),
        ...(currentTimestamp ? { timestamp: currentTimestamp } : {}),
        ...(currentModel ? { model: currentModel } : {}),
      });
    }
    currentParts = [];
  };
  for (const row of rows) {
    const messageId = String(row.message_id);
    if (messageId !== currentId) {
      flush();
      currentId = messageId;
      const data = parseDataRecord(row.message_data);
      currentRole = data?.role === "assistant" ? "assistant" : "user";
      currentTimestamp =
        toTimestampMs(readTimeCreated(data?.time)) ?? rowTimestamp(row, "time_created");
      currentModel = currentRole === "assistant" ? formatModelRecord(data?.model) : undefined;
    }
    const text = readString(parseDataRecord(row.part_data)?.text);
    if (text) currentParts.push(text);
  }
  flush();
  return capTranscript(messages);
}

function readTimeCreated(value: unknown): unknown {
  return isRecord(value) ? value.created : undefined;
}
