import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  buildSummary,
  capTranscript,
  homeDirs,
  isRecord,
  pathExists,
  readJsonLinesAll,
  readJsonLinesHead,
  readString,
  statOrNull,
  titleFromPrompt,
  toTimestampMs,
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

const CODEX_DIR = ".codex";
const STATE_DB_FILE = "state_5.sqlite";
/** `threads` keeps rows whose rollout file was deleted; prune them with bounded stats, not unbounded IO. */
const STAT_CONCURRENCY = 8;
/** session_meta is the first rollout record; a few spare head lines tolerate minor format drift. */
const META_HEAD_LINES = 5;

/** Without these two columns the index cannot be used at all (format drift → source unavailable). */
const THREAD_REQUIRED_COLUMNS = ["id", "rollout_path"] as const;
/** Metadata columns that differ between Codex versions; absent ones are simply not selected. */
const THREAD_OPTIONAL_COLUMNS = [
  "created_at",
  "created_at_ms",
  "updated_at",
  "updated_at_ms",
  "cwd",
  "title",
  "name",
  "first_user_message",
  "preview",
  "model",
  "git_branch",
  "source",
  "thread_source",
  "agent_role",
  "attached_thread_parent_id",
] as const;

/**
 * Builds the threads SELECT from the columns this database actually has. Codex 0.163 lacks
 * `attached_thread_parent_id`; selecting it unconditionally made the whole source unavailable.
 */
function buildThreadsQuery(db: DatabaseSync): string | null {
  const present = new Set(
    (db.prepare("PRAGMA table_info(threads)").all() as unknown[])
      .filter(isRecord)
      .map((column) => String(column.name)),
  );
  if (!THREAD_REQUIRED_COLUMNS.every((column) => present.has(column))) return null;
  const columns = [
    ...THREAD_REQUIRED_COLUMNS,
    ...THREAD_OPTIONAL_COLUMNS.filter((column) => present.has(column)),
  ];
  return `SELECT ${columns.join(", ")} FROM threads`;
}

const RELOCATE_QUERY = "SELECT rollout_path FROM threads WHERE id = ?";

interface ThreadCandidate {
  sessionId: string;
  workspacePath: string;
  rolloutPath: string;
  row: JsonRecord;
}

/** Only these content part kinds carry plain text; others (images, audio) are dropped. */
const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"]);

/** Codex injects these blocks as user messages; they are not conversation the user typed. */
const INJECTED_CONTEXT_PREFIXES = ["<environment_context>", "<user_instructions>", "# AGENTS.md"];

export const codexSessionsAdapter: ExternalSessionSourceAdapter = {
  source: "codex",
  list,
  readTranscript,
};

async function list(ctx: ExternalSessionScanContext): Promise<ExternalSessionSummary[]> {
  const byId = new Map<string, ExternalSessionSummary>();
  for (const homeDir of homeDirs(ctx)) {
    const codexRoot = join(homeDir, CODEX_DIR);
    if (!(await pathExists(codexRoot))) continue; // tool not installed for this home
    const dbPath = join(codexRoot, STATE_DB_FILE);
    // A state db that exists but cannot be opened makes the whole source unavailable (throw);
    // no state db at all means old Codex versions: fall back to rollout file heads.
    const sessions = (await pathExists(dbPath))
      ? await listFromStateDb(ctx, codexRoot, dbPath)
      : await listFromRolloutFiles(ctx, codexRoot);
    for (const session of sessions) {
      if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
    }
  }
  return [...byId.values()];
}

async function listFromStateDb(
  ctx: ExternalSessionScanContext,
  codexRoot: string,
  dbPath: string,
): Promise<ExternalSessionSummary[]> {
  const rows = withReadOnlySqlite(dbPath, (db) => {
    const query = buildThreadsQuery(db);
    if (!query) throw new Error(`codex: threads table without id/rollout_path in ${dbPath}`);
    return (db.prepare(query).all() as unknown[]).filter(isRecord);
  });
  const candidates: ThreadCandidate[] = [];
  for (const row of rows) {
    const sessionId = readString(row.id);
    const rolloutPathRaw = readString(row.rollout_path);
    if (!sessionId || !rolloutPathRaw) {
      ctx.warn(`codex thread row without id or rollout_path in ${dbPath} skipped`);
      continue;
    }
    if (isSubagentThread(row)) continue;
    candidates.push({
      sessionId,
      workspacePath: readString(row.cwd) ?? "",
      rolloutPath: resolve(codexRoot, rolloutPathRaw),
      row,
    });
  }
  const details = await mapWithConcurrency(candidates, STAT_CONCURRENCY, async (candidate) => ({
    // Stale rows (rollout deleted, e.g. after .zst cleanup) are a normal state: drop silently.
    rolloutIsFile: (await statOrNull(candidate.rolloutPath))?.isFile() ?? false,
    workspaceMissing: candidate.workspacePath ? !(await pathExists(candidate.workspacePath)) : true,
  }));
  const summaries: ExternalSessionSummary[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const detail = details[index];
    if (!detail?.rolloutIsFile) continue;
    summaries.push(buildThreadSummary(candidate, detail.workspaceMissing));
  }
  return summaries;
}

function buildThreadSummary(
  candidate: ThreadCandidate,
  workspaceMissing: boolean,
): ExternalSessionSummary {
  const { row } = candidate;
  const createdAt = toMs(row.created_at_ms) ?? toMs(row.created_at);
  const updatedAt = toMs(row.updated_at_ms) ?? toMs(row.updated_at);
  return buildSummary({
    source: "codex",
    sessionId: candidate.sessionId,
    workspacePath: candidate.workspacePath,
    workspaceMissing,
    title:
      readString(row.title) ??
      readString(row.name) ??
      titleFromPrompt(readString(row.first_user_message)) ??
      readString(row.preview),
    createdAt,
    updatedAt: updatedAt ?? createdAt ?? 0,
    model: readString(row.model),
    gitBranch: readString(row.git_branch),
    // Archived rows stay listed; they are still sessions, just not in the default Codex view.
    sourcePath: candidate.rolloutPath,
    transcriptAvailable: !candidate.rolloutPath.endsWith(".zst"),
  });
}

/** Subagents, guardian reviews and child threads are not user-facing sessions. */
const SUBAGENT_THREAD_SOURCES = new Set(["subagent", "guardian_review", "review"]);

function isSubagentThread(row: JsonRecord): boolean {
  // Real Codex writes thread_source "user" for interactive threads (and "main" in older builds);
  // only the explicit subagent kinds are excluded so a new source kind does not hide every session.
  const threadSource = readString(row.thread_source);
  if (threadSource && SUBAGENT_THREAD_SOURCES.has(threadSource)) return true;
  if (readString(row.source)?.includes("subagent")) return true;
  if (readString(row.agent_role)) return true;
  if (readString(row.attached_thread_parent_id)) return true;
  return false;
}

async function listFromRolloutFiles(
  ctx: ExternalSessionScanContext,
  codexRoot: string,
): Promise<ExternalSessionSummary[]> {
  const summaries: ExternalSessionSummary[] = [];
  for (const filePath of await collectRolloutFiles(join(codexRoot, "sessions"))) {
    try {
      const meta = (await readJsonLinesHead(filePath, META_HEAD_LINES)).find(
        (record) => record.type === "session_meta",
      );
      const payload = meta && isRecord(meta.payload) ? meta.payload : null;
      const sessionId = payload
        ? (readString(payload.id) ?? readString(payload.session_id))
        : undefined;
      if (!payload || !sessionId) {
        ctx.warn(`codex rollout ${filePath} without session_meta head skipped`);
        continue;
      }
      // The index path drops subagent threads; the rollout path must apply the same predicate to session_meta.
      if (isSubagentThread(payload)) continue;
      const workspacePath = readString(payload.cwd) ?? "";
      // session_meta holds the creation time only; a resumed rollout keeps growing, so its mtime is the activity time.
      const mtimeMs = Math.trunc((await statOrNull(filePath))?.mtimeMs ?? 0);
      const createdAt = toMs(payload.timestamp) ?? mtimeMs;
      summaries.push(
        buildSummary({
          source: "codex",
          sessionId,
          workspacePath,
          workspaceMissing: workspacePath ? !(await pathExists(workspacePath)) : true,
          createdAt,
          updatedAt: Math.max(createdAt, mtimeMs),
          gitBranch: isRecord(payload.git) ? readString(payload.git.branch) : undefined,
          sourcePath: filePath,
          transcriptAvailable: true,
        }),
      );
    } catch (error) {
      // One unreadable rollout (permissions, deleted mid-scan) must not hide the whole source.
      ctx.warn(`codex rollout ${filePath} could not be read`, error);
    }
  }
  return summaries;
}

/** Rollouts nest as sessions/YYYY/MM/DD/rollout-*.jsonl; walk exactly those levels, nothing else. */
async function collectRolloutFiles(sessionsRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const year of await safeReaddir(sessionsRoot)) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const month of await safeReaddir(join(sessionsRoot, year.name))) {
      if (!month.isDirectory() || !/^\d{1,2}$/.test(month.name)) continue;
      for (const day of await safeReaddir(join(sessionsRoot, year.name, month.name))) {
        if (!day.isDirectory() || !/^\d{1,2}$/.test(day.name)) continue;
        const dayDir = join(sessionsRoot, year.name, month.name, day.name);
        for (const entry of await safeReaddir(dayDir)) {
          if (
            entry.isFile() &&
            entry.name.startsWith("rollout-") &&
            entry.name.endsWith(".jsonl")
          ) {
            files.push(join(dayDir, entry.name));
          }
        }
      }
    }
  }
  return files;
}

async function safeReaddir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readTranscript(
  ctx: ExternalSessionScanContext,
  summary: ExternalSessionSummary,
): Promise<ExternalSessionTranscriptRead | null> {
  // `.jsonl.zst` archives are compressed; reading them is out of scope for v1.
  if (summary.sourcePath.endsWith(".zst")) return null;
  const rolloutPath = (await pathExists(summary.sourcePath))
    ? summary.sourcePath
    : await relocateRollout(ctx, summary.sessionId);
  if (!rolloutPath || rolloutPath.endsWith(".zst") || !(await pathExists(rolloutPath))) return null;
  let records: JsonRecord[];
  try {
    records = await readJsonLinesAll(rolloutPath);
  } catch (error) {
    ctx.warn(`codex rollout ${rolloutPath} could not be read`, error);
    return null;
  }
  return capTranscript(parseRolloutTranscript(records));
}

/** The summary may be stale; re-resolve the rollout through the state db before giving up. */
async function relocateRollout(
  ctx: ExternalSessionScanContext,
  sessionId: string,
): Promise<string | null> {
  for (const homeDir of homeDirs(ctx)) {
    const dbPath = join(homeDir, CODEX_DIR, STATE_DB_FILE);
    if (!(await pathExists(dbPath))) continue;
    try {
      const row = withReadOnlySqlite(dbPath, (db) => db.prepare(RELOCATE_QUERY).get(sessionId));
      const rolloutPath = isRecord(row) ? readString(row.rollout_path) : undefined;
      if (!rolloutPath) continue;
      const resolved = resolve(join(homeDir, CODEX_DIR), rolloutPath);
      if (await pathExists(resolved)) return resolved;
    } catch (error) {
      ctx.warn(`codex state db ${dbPath} could not be consulted`, error);
    }
  }
  return null;
}

function parseRolloutTranscript(
  records: readonly JsonRecord[],
): ExternalSessionTranscriptMessage[] {
  const messages: ExternalSessionTranscriptMessage[] = [];
  let model: string | undefined;
  for (const record of records) {
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!payload) continue;
    const type = record.type;
    if (type === "turn_context") {
      model = readString(payload.model) ?? model;
      continue;
    }
    // `thread_rolled_back` (codex-rs protocol ThreadRolledBackEvent) removes the last `num_turns` user turns
    // from context; the rollout keeps the removed records, so replay the rollback before extracting text.
    if (type === "event_msg" && payload.type === "thread_rolled_back") {
      rollBackUserTurns(messages, Number(payload.num_turns));
      continue;
    }
    if (type !== "response_item" || payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue; // developer and system never render
    const text = concatTextParts(payload.content);
    if (!text) continue;
    if (role === "user" && isInjectedContext(text)) continue;
    const timestamp = toTimestampMs(record.timestamp);
    messages.push({
      role,
      text,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }
  return messages;
}

/** Drops the last `numTurns` user messages and everything after each of them (a turn = one user prompt). */
function rollBackUserTurns(messages: ExternalSessionTranscriptMessage[], numTurns: number): void {
  if (!Number.isFinite(numTurns) || numTurns <= 0) return;
  let remaining = Math.trunc(numTurns);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    remaining -= 1;
    if (remaining === 0) {
      messages.length = index;
      return;
    }
  }
  messages.length = 0;
}

function concatTextParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (
      typeof part.type === "string" &&
      TEXT_PART_TYPES.has(part.type) &&
      typeof part.text === "string"
    ) {
      if (part.text.length > 0) parts.push(part.text);
    }
  }
  return parts.join("\n\n");
}

function isInjectedContext(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_CONTEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** node:sqlite may surface large INTEGER columns as bigint; both timestamp columns coerce safely. */
function toMs(value: unknown): number | undefined {
  return toTimestampMs(typeof value === "bigint" ? Number(value) : value);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
