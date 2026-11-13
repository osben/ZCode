import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSummary,
  homeDirs,
  isRecord,
  pathExists,
  readString,
  statOrNull,
  toTimestampMs,
  type JsonRecord,
} from "#src/external-sessions/adapters/shared.js";
import type {
  ExternalSessionScanContext,
  ExternalSessionSourceAdapter,
} from "#src/external-sessions/adapters/types.js";
import type { ExternalSessionSummary } from "#src/external-sessions/contract.js";

/** Cursor nests subagent sessions under a `subagents/` directory; never enumerate it. */
const SUBAGENTS_DIR_NAME = "subagents";

/**
 * Cursor, metadata only (specs/external-sessions.md "Sources"). Two roots under `<home>/.cursor`:
 * `acp-sessions/<uuid>/meta.json` and `chats/<md5(cwd)>/<agentId>/meta.json`. Transcript bodies
 * live in an opaque `store.db` blob store whose format is not understood, so
 * `transcriptAvailable` is always false and `readTranscript` always returns null.
 */
export const cursorSessionsAdapter: ExternalSessionSourceAdapter = {
  source: "cursor",
  list: listCursorSessions,
  readTranscript: async () => null,
};

async function listCursorSessions(
  ctx: ExternalSessionScanContext,
): Promise<ExternalSessionSummary[]> {
  const byId = new Map<string, ExternalSessionSummary>();
  for (const home of homeDirs(ctx)) {
    const cursorRoot = join(home, ".cursor");
    if (!(await pathExists(cursorRoot))) continue;
    const summaries = [
      ...(await listAcpSessions(ctx, cursorRoot)),
      ...(await listChatSessions(ctx, cursorRoot)),
    ];
    for (const summary of summaries) {
      // The same home may be probed twice (homeDir plus extraHomeDirs); keep the first hit.
      if (!byId.has(summary.sessionId)) byId.set(summary.sessionId, summary);
    }
  }
  return [...byId.values()];
}

/** `<home>/.cursor/acp-sessions/<uuid>/meta.json` + `store.db` (mtime only, never its contents). */
async function listAcpSessions(
  ctx: ExternalSessionScanContext,
  cursorRoot: string,
): Promise<ExternalSessionSummary[]> {
  const root = join(cursorRoot, "acp-sessions");
  if (!(await pathExists(root))) return [];
  const summaries: ExternalSessionSummary[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === SUBAGENTS_DIR_NAME) continue;
    const summary = await readAcpSession(ctx, join(root, entry.name), entry.name);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

async function readAcpSession(
  ctx: ExternalSessionScanContext,
  sessionDir: string,
  sessionId: string,
): Promise<ExternalSessionSummary | null> {
  const metaPath = join(sessionDir, "meta.json");
  const metaStat = await statOrNull(metaPath);
  if (!metaStat?.isFile()) return null;
  const meta = await readMetaRecord(ctx, metaPath);
  if (!meta) return null;
  const cwd = readString(meta.cwd);
  if (!cwd) {
    ctx.warn(`cursor: acp session meta.json has no cwd: ${metaPath}`);
    return null;
  }
  // acp meta.json carries no timestamps; the file system is the only clock. Filesystems without
  // birthtime report 0, so fall back to the mtime instead of trusting the epoch.
  const birthMs = metaStat.birthtimeMs > 0 ? metaStat.birthtimeMs : metaStat.mtimeMs;
  const createdAt = Math.min(birthMs, metaStat.mtimeMs);
  const storeStat = await statOrNull(join(sessionDir, "store.db"));
  const updatedAt = Math.max(metaStat.mtimeMs, storeStat?.mtimeMs ?? 0);
  return buildSummary({
    source: "cursor",
    sessionId,
    workspacePath: cwd,
    workspaceMissing: !(await pathExists(cwd)),
    title: readString(meta.title),
    createdAt,
    updatedAt,
    sourcePath: sessionDir,
    transcriptAvailable: false,
  });
}

/** `<home>/.cursor/chats/<md5-of-cwd>/<agentId>/meta.json`; the hash itself is ignored (cwd comes from meta). */
async function listChatSessions(
  ctx: ExternalSessionScanContext,
  cursorRoot: string,
): Promise<ExternalSessionSummary[]> {
  const root = join(cursorRoot, "chats");
  if (!(await pathExists(root))) return [];
  const summaries: ExternalSessionSummary[] = [];
  for (const hashEntry of await readdir(root, { withFileTypes: true })) {
    if (!hashEntry.isDirectory()) continue;
    const hashDir = join(root, hashEntry.name);
    // Some hash dirs hold a bare store.db with no agent sessions; not a session container.
    if (await pathExists(join(hashDir, "store.db"))) continue;
    for (const agentEntry of await readdir(hashDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory() || agentEntry.name === SUBAGENTS_DIR_NAME) continue;
      const summary = await readChatSession(ctx, join(hashDir, agentEntry.name), agentEntry.name);
      if (summary) summaries.push(summary);
    }
  }
  return summaries;
}

async function readChatSession(
  ctx: ExternalSessionScanContext,
  sessionDir: string,
  sessionId: string,
): Promise<ExternalSessionSummary | null> {
  const metaPath = join(sessionDir, "meta.json");
  const meta = await readMetaRecord(ctx, metaPath);
  if (!meta) return null;
  // Cursor writes hasConversation:false for agent records that never got a message; nothing to show.
  if (meta.hasConversation === false) return null;
  const cwd = readString(meta.cwd);
  if (!cwd) {
    ctx.warn(`cursor: chat session meta.json has no cwd: ${metaPath}`);
    return null;
  }
  const metaStat = await statOrNull(metaPath);
  const updatedAt = toTimestampMs(meta.updatedAtMs) ?? metaStat?.mtimeMs ?? ctx.now();
  const createdAt = toTimestampMs(meta.createdAtMs) ?? updatedAt;
  return buildSummary({
    source: "cursor",
    sessionId,
    workspacePath: cwd,
    workspaceMissing: !(await pathExists(cwd)),
    createdAt,
    updatedAt,
    sourcePath: sessionDir,
    transcriptAvailable: false,
  });
}

/**
 * Reads and parses one session's meta.json. Returns null when the file is absent (a structural
 * directory, skipped silently) or unusable (warned by the caller's rules inside this helper).
 */
async function readMetaRecord(
  ctx: ExternalSessionScanContext,
  metaPath: string,
): Promise<JsonRecord | null> {
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.warn(`cursor: cannot read meta.json at ${metaPath}`, error);
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("meta.json is not a JSON object");
    return parsed;
  } catch (error) {
    ctx.warn(`cursor: malformed meta.json at ${metaPath}`, error);
    return null;
  }
}
