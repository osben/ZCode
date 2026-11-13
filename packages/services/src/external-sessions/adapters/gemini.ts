import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSummary,
  capTranscript,
  homeDirs,
  isRecord,
  forEachJsonRecord,
  pathExists,
  pushTranscriptMessage,
  readJsonLinesHead,
  readJsonLinesTail,
  readString,
  statOrNull,
  titleFromPrompt,
  toTimestampMs,
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

/** Listing reads the header plus the first prompts from the head, and metadata from this tail window. */
const HEAD_LINES = 12;
const TAIL_BYTES = 64 * 1024;

/**
 * Gemini CLI (specs/external-sessions.md "Sources"). Sessions live at
 * `<home>/.gemini/tmp/<name>/chats/session-*.jsonl`; `<name>` maps back to the project path via
 * `projects.json` (`{"projects": {"<abs path>": "<name>"}}`) or, when that file is absent, via
 * `<home>/.gemini/history/<name>/.project_root`. Line 1 is a header with `kind` ("main" is a
 * top-level chat; anything else is a subagent run and excluded); later lines are message records
 * interleaved with `{"$set": {"lastUpdated": ...}}` metadata updates.
 */
export const geminiSessionsAdapter: ExternalSessionSourceAdapter = {
  source: "gemini",
  list: listGeminiSessions,
  readTranscript: readGeminiTranscript,
};

async function listGeminiSessions(
  ctx: ExternalSessionScanContext,
): Promise<ExternalSessionSummary[]> {
  const byId = new Map<string, ExternalSessionSummary>();
  for (const home of homeDirs(ctx)) {
    const root = join(home, ".gemini");
    if (!(await pathExists(root))) continue;
    // The same home may be probed twice (homeDir plus extraHomeDirs); keep the first hit per id.
    for (const summary of await listHomeSessions(ctx, root)) {
      if (!byId.has(summary.sessionId)) byId.set(summary.sessionId, summary);
    }
  }
  return [...byId.values()];
}

async function listHomeSessions(
  ctx: ExternalSessionScanContext,
  root: string,
): Promise<ExternalSessionSummary[]> {
  const tmpRoot = join(root, "tmp");
  if (!(await pathExists(tmpRoot))) return [];
  const nameToPath = await readProjectsReverseMap(ctx, join(root, "projects.json"));
  const summaries: ExternalSessionSummary[] = [];
  for (const nameEntry of await readdir(tmpRoot, { withFileTypes: true })) {
    if (!nameEntry.isDirectory()) continue;
    const chatsDir = join(tmpRoot, nameEntry.name, "chats");
    if (!(await pathExists(chatsDir))) continue;
    const workspacePath =
      nameToPath.get(nameEntry.name) ??
      (await readProjectRootFile(join(root, "history", nameEntry.name, ".project_root")));
    for (const fileEntry of await readdir(chatsDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
      const file = join(chatsDir, fileEntry.name);
      if (!workspacePath) {
        // Neither projects.json nor .project_root resolves this directory; without a cwd the
        // session cannot be matched to a workspace, so it is skipped rather than listed blindly.
        ctx.warn(`gemini: no project path for session ${file}`);
        continue;
      }
      const summary = await readSessionSummary(ctx, file, workspacePath);
      if (summary) summaries.push(summary);
    }
  }
  return summaries;
}

async function readSessionSummary(
  ctx: ExternalSessionScanContext,
  file: string,
  workspacePath: string,
): Promise<ExternalSessionSummary | null> {
  let head: JsonRecord[];
  try {
    head = await readJsonLinesHead(file, HEAD_LINES);
  } catch (error) {
    ctx.warn(`gemini: cannot read session ${file}`, error);
    return null;
  }
  const header = head[0];
  const sessionId = header ? readString(header.sessionId) : undefined;
  if (!header || !sessionId) {
    // Covers both an empty file and one whose first line is not the JSON header.
    ctx.warn(`gemini: malformed session header in ${file}`);
    return null;
  }
  // kind "main" marks a top-level chat; other kinds are subagent/sidechain runs.
  const kind = readString(header.kind);
  if (kind && kind !== "main") return null;

  const fileStat = await statOrNull(file);
  let tail: JsonRecord[] = [];
  let tailCoveredWholeFile = false;
  if (fileStat?.isFile()) {
    try {
      tail = await readJsonLinesTail(file, TAIL_BYTES);
      tailCoveredWholeFile = fileStat.size <= TAIL_BYTES;
    } catch (error) {
      ctx.warn(`gemini: cannot read the tail of ${file}`, error);
    }
  }

  let updatedAt = toTimestampMs(header.lastUpdated) ?? 0;
  let model: string | undefined;
  for (const record of tail) {
    const set = record["$set"];
    if (isRecord(set)) {
      const setMs = toTimestampMs(set.lastUpdated);
      if (setMs !== undefined && setMs > updatedAt) updatedAt = setMs;
      continue;
    }
    if (readString(record.type) === "gemini") {
      // Records are in order, so the last gemini model seen is the newest one.
      const recordModel = readString(record.model);
      if (recordModel) model = recordModel;
    }
  }
  updatedAt = Math.max(updatedAt, fileStat?.mtimeMs ?? 0);

  const messageCount = tailCoveredWholeFile
    ? tail.filter((record) => {
        const type = readString(record.type);
        return type === "user" || type === "gemini";
      }).length
    : undefined;

  return buildSummary({
    source: "gemini",
    sessionId,
    workspacePath,
    workspaceMissing: !(await pathExists(workspacePath)),
    title: firstUserTitle(head),
    createdAt: toTimestampMs(header.startTime),
    updatedAt,
    model,
    messageCount,
    sourcePath: file,
    transcriptAvailable: true,
  });
}

/** The first user prompt that still says something once tag blocks (session_context) are stripped. */
function firstUserTitle(head: readonly JsonRecord[]): string | undefined {
  for (const record of head) {
    if (readString(record.type) !== "user") continue;
    const title = titleFromPrompt(contentText(record.content));
    if (title) return title;
  }
  return undefined;
}

async function readProjectsReverseMap(
  ctx: ExternalSessionScanContext,
  projectsPath: string,
): Promise<Map<string, string>> {
  const reverse = new Map<string, string>();
  if (!(await pathExists(projectsPath))) return reverse;
  try {
    const parsed: unknown = JSON.parse(await readFile(projectsPath, "utf-8"));
    const projects = isRecord(parsed) ? parsed.projects : undefined;
    if (!isRecord(projects)) return reverse;
    for (const [projectPath, name] of Object.entries(projects)) {
      if (typeof name === "string" && name && !reverse.has(name)) reverse.set(name, projectPath);
    }
  } catch (error) {
    // A corrupt projects.json must not hide the sessions; .project_root still resolves them.
    ctx.warn(`gemini: malformed projects.json at ${projectsPath}`, error);
  }
  return reverse;
}

async function readProjectRootFile(projectRootPath: string): Promise<string | undefined> {
  try {
    // The file holds one absolute path; trim the trailing newline instead of trusting the writer.
    const trimmed = (await readFile(projectRootPath, "utf-8")).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function readGeminiTranscript(
  ctx: ExternalSessionScanContext,
  summary: ExternalSessionSummary,
): Promise<ExternalSessionTranscriptRead | null> {
  const file = summary.sourcePath;
  if (!(await pathExists(file))) return null;
  // Gemini keeps every record: its journal patches and rewinds address earlier messages by id, so a bounded
  // window would change the replay result. Streaming still avoids holding the raw file text in memory.
  const records: JsonRecord[] = [];
  try {
    await forEachJsonRecord(file, (record) => {
      records.push(record);
    });
  } catch (error) {
    ctx.warn(`gemini: cannot read transcript ${file}`, error);
    return null;
  }
  const header = records[0];
  if (!header || readString(header.sessionId) !== summary.sessionId) return null;

  const messages: ExternalSessionTranscriptMessage[] = [];
  for (const record of replayGeminiJournal(records.slice(1))) {
    const type = readString(record.type);
    if (type !== "user" && type !== "gemini") continue;
    let text = contentText(record.content) ?? "";
    if (type === "user") text = stripLeadingSessionContext(text);
    if (!text.trim()) continue;
    const timestamp = toTimestampMs(record.timestamp);
    const model = type === "gemini" ? readString(record.model) : undefined;
    pushTranscriptMessage(messages, {
      role: type === "user" ? "user" : "assistant",
      text,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(model ? { model } : {}),
    });
  }
  return capTranscript(messages);
}

/** `content` is either a bare string or an array of `{text}` parts joined by newlines. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && typeof part.text === "string" && part.text.length > 0)
      parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Gemini CLI prepends a `<session_context>` environment block to the first user prompt; drop it. */
function stripLeadingSessionContext(text: string): string {
  return text.replace(/^\s*<session_context>[\s\S]*?<\/session_context>\s*/, "");
}

/**
 * Replays the Gemini CLI conversation journal the way its loader does (chatRecordingService.ts):
 * message records are keyed by `id`; `{"$rewindTo": id}` drops that message and everything after it
 * (or everything when the id is unknown); `{"$patch": {...}}` replaces content by id (`id` or
 * `updates[]`), removes `removeIds` and reorders `orderIds`; `{"$set": {messages: [...]}}` replaces
 * the whole conversation. Without this, a rewound answer or an edited prompt would still be shown.
 */
export function replayGeminiJournal(records: readonly JsonRecord[]): JsonRecord[] {
  const map = new Map<string, JsonRecord>();
  const applyPatch = (patch: unknown) => {
    if (!isRecord(patch)) return;
    const id = readString(patch.id);
    if (!id) return;
    const existing = map.get(id);
    if (!existing) return;
    if ("content" in patch && patch.content !== undefined) {
      map.set(id, { ...existing, content: patch.content });
    }
  };
  for (const record of records) {
    const rewindTo = readString(record.$rewindTo);
    if (rewindTo !== undefined) {
      if (map.has(rewindTo)) {
        let found = false;
        for (const id of [...map.keys()]) {
          if (id === rewindTo) found = true;
          if (found) map.delete(id);
        }
      } else {
        map.clear();
      }
      continue;
    }
    if (isRecord(record.$patch)) {
      const patch = record.$patch;
      applyPatch(patch);
      if (Array.isArray(patch.updates)) for (const update of patch.updates) applyPatch(update);
      if (Array.isArray(patch.removeIds)) {
        for (const removeId of patch.removeIds) {
          if (typeof removeId === "string") map.delete(removeId);
        }
      }
      if (Array.isArray(patch.orderIds)) {
        const ordered: [string, JsonRecord][] = [];
        for (const id of patch.orderIds) {
          const message = typeof id === "string" ? map.get(id) : undefined;
          if (message && typeof id === "string") ordered.push([id, message]);
        }
        const orderedIds = new Set(ordered.map(([id]) => id));
        const prefix = [...map.entries()].filter(([id]) => !orderedIds.has(id));
        map.clear();
        for (const [id, message] of [...prefix, ...ordered]) map.set(id, message);
      }
      continue;
    }
    if (isRecord(record.$set)) {
      if (Array.isArray(record.$set.messages)) {
        map.clear();
        for (const message of record.$set.messages) {
          const id = isRecord(message) ? readString(message.id) : undefined;
          if (id && isRecord(message)) map.set(id, message);
        }
      }
      continue;
    }
    const id = readString(record.id);
    if (id) map.set(id, record);
  }
  return [...map.values()];
}
