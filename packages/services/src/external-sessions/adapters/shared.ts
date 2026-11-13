import { createReadStream } from "node:fs";
import { access, copyFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_TRANSCRIPT_CHARS_PER_MESSAGE,
  MAX_TRANSCRIPT_MESSAGES,
  buildExternalSessionFallbackTitle,
  buildExternalSessionKey,
  buildExternalSessionResumeCommand,
  type ExternalSessionSource,
  type ExternalSessionSummary,
  type ExternalSessionTranscriptMessage,
} from "#src/external-sessions/contract.js";
import type { ExternalSessionTranscriptRead } from "#src/external-sessions/adapters/types.js";

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Accepts unix seconds, unix ms or ISO strings; anything else is undefined. */
export function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return Math.trunc(value);
    if (value > 1_000_000_000) return Math.trunc(value * 1000);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return toTimestampMs(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** Reads up to `maxLines` non-empty JSON lines from the top of a file; a malformed line is skipped. */
export async function readJsonLinesHead(filePath: string, maxLines: number): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  if (maxLines <= 0) return records;
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const parsed = parseJsonRecord(line);
      if (parsed) records.push(parsed);
      if (records.length >= maxLines) break;
    }
    return records;
  } finally {
    reader.close();
    stream.destroy();
  }
}

/** Reads the last `maxBytes` of a file and returns its complete JSON lines (the first partial line is dropped). */
export async function readJsonLinesTail(filePath: string, maxBytes: number): Promise<JsonRecord[]> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf-8");
    if (length < size) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map(parseJsonRecord)
      .filter((record): record is JsonRecord => record !== null);
  } finally {
    await handle.close();
  }
}

/**
 * Streams every JSON line of a file through `visit`, one line at a time; malformed lines are skipped.
 * Memory is bounded by the longest single line, not by the file size, so a long transcript never
 * has to fit in memory before the caller's caps apply. Only used for a transcript the user opened.
 */
export async function forEachJsonRecord(
  filePath: string,
  visit: (record: JsonRecord) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const parsed = parseJsonRecord(line);
      if (parsed) visit(parsed);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

/** Upper bound of messages a streaming transcript replay keeps before the final cap; see pushTranscriptMessage. */
const TRANSCRIPT_WINDOW_MESSAGES = MAX_TRANSCRIPT_MESSAGES * 2;

/**
 * Appends to a streaming transcript window. The window keeps the newest messages and each text is cut at
 * the per-message limit on entry, so a huge single message cannot grow memory. `capTranscript` still applies
 * the final caps and the `truncated` flag.
 */
export function pushTranscriptMessage(
  messages: ExternalSessionTranscriptMessage[],
  message: ExternalSessionTranscriptMessage,
): void {
  const text =
    message.text.length > MAX_TRANSCRIPT_CHARS_PER_MESSAGE
      ? message.text.slice(0, MAX_TRANSCRIPT_CHARS_PER_MESSAGE + 1)
      : message.text;
  messages.push(text === message.text ? message : { ...message, text });
  if (messages.length > TRANSCRIPT_WINDOW_MESSAGES) {
    messages.splice(0, messages.length - TRANSCRIPT_WINDOW_MESSAGES);
  }
}

function parseJsonRecord(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Runs `fn` on another tool's SQLite store without writing anything next to it. A plain read-only open still
 * creates `-shm` (and can replay `-wal`) beside the source, so:
 * - with a non-empty `-wal`, the db and its wal are copied into a private temp dir and that copy is opened
 *   (committed rows live only in the wal, and the copy is small for the stores that have one);
 * - otherwise the file is opened with `immutable=1`, which takes no locks and creates no sidecar files.
 * The connection and the temp copy are released before returning. The caller treats a throw as "source unavailable".
 */
export async function withReadOnlySqlite<T>(
  dbPath: string,
  fn: (db: DatabaseSync) => T,
): Promise<T> {
  const walPath = `${dbPath}-wal`;
  const wal = await statOrNull(walPath);
  if (wal && wal.size > 0) {
    const copyDir = await mkdtemp(join(tmpdir(), "zcode-external-sessions-"));
    try {
      const copyPath = join(copyDir, "store.sqlite");
      await copyFile(dbPath, copyPath);
      await copyFile(walPath, `${copyPath}-wal`);
      return openReadOnly(copyPath, fn);
    } finally {
      await rm(copyDir, { recursive: true, force: true });
    }
  }
  return openReadOnly(`${pathToFileURL(dbPath).href}?immutable=1`, fn);
}

function openReadOnly<T>(target: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Builds a summary with the derived fields (key, title fallback, resume command) filled in. */
export function buildSummary(params: {
  source: ExternalSessionSource;
  sessionId: string;
  workspacePath: string;
  workspaceMissing: boolean;
  title?: string;
  createdAt?: number;
  updatedAt: number;
  model?: string;
  gitBranch?: string;
  messageCount?: number;
  sourcePath: string;
  transcriptAvailable: boolean;
  importable?: boolean;
}): ExternalSessionSummary {
  const title =
    params.title?.trim() || buildExternalSessionFallbackTitle(params.source, params.sessionId);
  const createdAt = params.createdAt ?? params.updatedAt;
  return {
    source: params.source,
    sessionId: params.sessionId,
    key: buildExternalSessionKey(params.source, params.sessionId),
    workspacePath: params.workspacePath,
    workspaceMissing: params.workspaceMissing,
    title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
    createdAt,
    updatedAt: Math.max(createdAt, params.updatedAt),
    ...(params.model ? { model: params.model } : {}),
    ...(params.gitBranch ? { gitBranch: params.gitBranch } : {}),
    ...(params.messageCount !== undefined ? { messageCount: params.messageCount } : {}),
    sourcePath: params.sourcePath,
    transcriptAvailable: params.transcriptAvailable,
    importable: params.importable === true,
    resumeCommand: buildExternalSessionResumeCommand(params.source, params.sessionId),
  };
}

const TITLE_SCAN_CHARS = 4096;

/** Derives a one-line title from the first user prompt (first non-empty line, trimmed to 80 chars). */
export function titleFromPrompt(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Bound the input before the tag-stripping regex: on a long prompt with many unclosed `<` tags the
  // lazy `[\s\S]*?` scan is super-linear (920 KB took 2.8 s). A title needs only the first line.
  const line = text
    .slice(0, TITLE_SCAN_CHARS)
    .replace(/<[^>]{1,64}>[\s\S]*?<\/[^>]{1,64}>/g, " ")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Applies the transcript caps from the spec (message count and per-message characters). */
export function capTranscript(
  messages: readonly ExternalSessionTranscriptMessage[],
): ExternalSessionTranscriptRead {
  let truncated = messages.length > MAX_TRANSCRIPT_MESSAGES;
  const kept = truncated
    ? messages.slice(messages.length - MAX_TRANSCRIPT_MESSAGES)
    : [...messages];
  const capped = kept.map((message) => {
    if (message.text.length <= MAX_TRANSCRIPT_CHARS_PER_MESSAGE) return message;
    truncated = true;
    return { ...message, text: `${message.text.slice(0, MAX_TRANSCRIPT_CHARS_PER_MESSAGE)}…` };
  });
  return { messages: capped, truncated };
}

export function homeDirs(ctx: { homeDir: string; extraHomeDirs?: readonly string[] }): string[] {
  return [...new Set([ctx.homeDir, ...(ctx.extraHomeDirs ?? [])].filter((item) => item.trim()))];
}
