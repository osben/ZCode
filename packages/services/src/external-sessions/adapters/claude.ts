import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  extractClaudeNativeSessionHeadInfo,
  hasClaudeNativeSidechainMarker,
} from "#src/session/claude-native/claudeNativeSessionHeadParser.js";
import { parseClaudeNativeSessionFile } from "#src/session/claude-native/claudeNativeSessionImportParser.js";
import { readJsonLinesFileHead } from "#src/session/claude-native/sessionHistoryJsonl.js";
import type {
  ExternalSessionSummary,
  ExternalSessionTranscriptMessage,
} from "#src/external-sessions/contract.js";
import type {
  ExternalSessionScanContext,
  ExternalSessionSourceAdapter,
} from "#src/external-sessions/adapters/types.js";
import {
  buildSummary,
  capTranscript,
  homeDirs,
  pathExists,
  readJsonLinesTail,
  readString,
  statOrNull,
} from "#src/external-sessions/adapters/shared.js";

const HEAD_RECORDS = 16;
const TAIL_BYTES = 64 * 1024;

/**
 * Claude Code keeps one JSONL per session under ~/.claude/projects/<slug>/<sessionId>.jsonl; the slug is a
 * lossy transform of the cwd, so the workspace comes from the records (upstream head parser). Subagent
 * transcripts live in <sessionId>/subagents/ and never at the top level of a slug directory.
 */
async function listSessionFiles(projectsRoot: string): Promise<string[]> {
  const files: string[] = [];
  let slugs: string[];
  try {
    slugs = await readdir(projectsRoot);
  } catch {
    return files;
  }
  for (const slug of slugs) {
    const slugDir = join(projectsRoot, slug);
    let entries;
    try {
      entries = await readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(slugDir, entry.name));
    }
  }
  return files;
}

interface TailInfo {
  customTitle?: string;
  agentName?: string;
  gitBranch?: string;
  model?: string;
  lastTimestamp?: number;
}

/** The newest custom title, agent name, branch and model are usually in the last records. */
function readTailInfo(records: readonly Record<string, unknown>[]): TailInfo {
  const info: TailInfo = {};
  for (const record of records) {
    const type = readString(record.type);
    if (type === "custom-title")
      info.customTitle = readString(record.customTitle) ?? info.customTitle;
    if (type === "agent-name") info.agentName = readString(record.agentName) ?? info.agentName;
    const branch = readString(record.gitBranch);
    if (branch) info.gitBranch = branch;
    const message = record.message;
    if (type === "assistant" && typeof message === "object" && message !== null) {
      const model = readString((message as Record<string, unknown>).model);
      if (model) info.model = model;
    }
    const timestamp = readString(record.timestamp);
    if (timestamp) {
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed)) info.lastTimestamp = parsed;
    }
  }
  return info;
}

async function summarizeFile(
  ctx: ExternalSessionScanContext,
  filePath: string,
): Promise<ExternalSessionSummary | null> {
  const fileStat = await statOrNull(filePath);
  if (!fileStat) return null;
  const head = await readJsonLinesFileHead(filePath, HEAD_RECORDS);
  if (head.length === 0 || hasClaudeNativeSidechainMarker(head)) return null;
  const headInfo = extractClaudeNativeSessionHeadInfo(head);
  if (!headInfo.workspacePath) return null;
  const tail = readTailInfo(await readJsonLinesTail(filePath, TAIL_BYTES));
  const sessionId = basename(filePath, ".jsonl");
  return buildSummary({
    source: "claude",
    sessionId,
    workspacePath: headInfo.workspacePath,
    workspaceMissing: !(await pathExists(headInfo.workspacePath)),
    title: tail.customTitle ?? tail.agentName ?? headInfo.previewTitle,
    createdAt: headInfo.createdAt,
    updatedAt: Math.max(tail.lastTimestamp ?? 0, Math.trunc(fileStat.mtimeMs)),
    model: tail.model,
    gitBranch: tail.gitBranch,
    sourcePath: filePath,
    transcriptAvailable: true,
  });
}

export const claudeSessionsAdapter: ExternalSessionSourceAdapter = {
  source: "claude",

  async list(ctx) {
    const files = new Set<string>();
    for (const home of homeDirs(ctx)) {
      for (const file of await listSessionFiles(join(home, ".claude", "projects"))) files.add(file);
    }
    const summaries: ExternalSessionSummary[] = [];
    const seen = new Set<string>();
    for (const filePath of files) {
      try {
        const summary = await summarizeFile(ctx, filePath);
        if (summary && !seen.has(summary.sessionId)) {
          seen.add(summary.sessionId);
          summaries.push(summary);
        }
      } catch (error) {
        ctx.warn(`claude session skipped path=${filePath}`, error);
      }
    }
    return summaries;
  },

  async readTranscript(_ctx, summary) {
    if (!(await pathExists(summary.sourcePath))) return null;
    const parsed = await parseClaudeNativeSessionFile({
      filePath: summary.sourcePath,
      workspacePath: summary.workspacePath,
      sessionId: summary.sessionId,
    });
    const messages: ExternalSessionTranscriptMessage[] = parsed.messages
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({
        role: message.role,
        text: message.content,
        timestamp: message.timestamp,
        ...(message.model ? { model: message.model } : {}),
      }));
    return capTranscript(messages);
  },
};
