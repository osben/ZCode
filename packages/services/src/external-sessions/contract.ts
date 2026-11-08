import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

/**
 * Sessions recorded by other AI coding CLIs on this machine (specs/external-sessions.md).
 * Browser-safe: types, the source catalog and pure helpers only; no Node imports.
 */
export const EXTERNAL_SESSION_SOURCES = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "gemini",
] as const;
export type ExternalSessionSource = (typeof EXTERNAL_SESSION_SOURCES)[number];

export interface ExternalSessionSourceInfo {
  source: ExternalSessionSource;
  /** Product name; stays untranslated. */
  label: string;
  /** The CLI binary the resume command runs. */
  binary: string;
}

export const EXTERNAL_SESSION_SOURCE_CATALOG: readonly ExternalSessionSourceInfo[] = [
  { source: "claude", label: "Claude Code", binary: "claude" },
  { source: "codex", label: "Codex", binary: "codex" },
  { source: "opencode", label: "OpenCode", binary: "opencode" },
  { source: "cursor", label: "Cursor", binary: "cursor-agent" },
  { source: "gemini", label: "Gemini CLI", binary: "gemini" },
];

export function externalSessionSourceLabel(source: ExternalSessionSource): string {
  return EXTERNAL_SESSION_SOURCE_CATALOG.find((item) => item.source === source)?.label ?? source;
}

export interface ExternalSessionSummary {
  source: ExternalSessionSource;
  sessionId: string;
  /** Stable row key `${source}:${sessionId}`. */
  key: string;
  /** The session's own cwd as the tool recorded it. */
  workspacePath: string;
  workspaceMissing: boolean;
  /** Never empty; falls back to the source label plus a short id. */
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  gitBranch?: string;
  /** user + assistant messages when the listing can know it cheaply. */
  messageCount?: number;
  /** File or database path backing the session, for "Show in file manager" and diagnostics. */
  sourcePath: string;
  transcriptAvailable: boolean;
  /** The upstream Claude Code importer accepts this session (it skips `.claude/worktree(s)` cwds); false elsewhere. */
  importable: boolean;
  /** Ready to paste into a shell in `workspacePath`; empty when the id fails the id pattern. */
  resumeCommand: string;
}

export interface ExternalSessionsListParams {
  /** Omit for every workspace. */
  workspacePath?: string;
  sources?: ExternalSessionSource[];
  /** Case-insensitive substring over title and session id. */
  search?: string;
  /** Default 200, max 1000. */
  limit?: number;
  /** Bypass the per-Host cache. */
  refresh?: boolean;
}

export interface ExternalSessionSourceStatus {
  available: boolean;
  /** Sessions this source contributed before workspace/search filters. */
  count: number;
  reason?: string;
}

export interface ExternalSessionsListResult {
  /** Sorted by `updatedAt` descending. */
  sessions: ExternalSessionSummary[];
  sources: Record<ExternalSessionSource, ExternalSessionSourceStatus>;
  scannedAt: number;
}

export interface ExternalSessionRef {
  source: ExternalSessionSource;
  sessionId: string;
}

export interface ExternalSessionTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  model?: string;
}

export interface ExternalSessionTranscript {
  summary: ExternalSessionSummary;
  messages: ExternalSessionTranscriptMessage[];
  truncated: boolean;
}

export interface ExternalSessionTerminalResult {
  opened: boolean;
  /** The full line the terminal runs (or would run), for the clipboard fallback. */
  command: string;
  error?: string;
}

export interface IExternalSessionsService {
  listExternalSessions(params: ExternalSessionsListParams): Promise<ExternalSessionsListResult>;
  /** Rejects with `EXTERNAL_SESSION_NOT_FOUND` or `EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE`. */
  readExternalSessionTranscript(ref: ExternalSessionRef): Promise<ExternalSessionTranscript>;
  /** macOS: opens Terminal.app in the session cwd running the resume command; elsewhere `{opened:false}`. */
  openExternalSessionInTerminal(ref: ExternalSessionRef): Promise<ExternalSessionTerminalResult>;
}

export const IExternalSessionsService = createServiceDescriptor<IExternalSessionsService>(
  ServiceChannels.ExternalSessions,
);

export const EXTERNAL_SESSION_NOT_FOUND = "EXTERNAL_SESSION_NOT_FOUND";
export const EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE = "EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE";

export const EXTERNAL_SESSIONS_DEFAULT_LIMIT = 200;
export const EXTERNAL_SESSIONS_MAX_LIMIT = 1000;
export const EXTERNAL_SESSIONS_CACHE_TTL_MS = 15_000;
export const MAX_TRANSCRIPT_MESSAGES = 200;
export const MAX_TRANSCRIPT_CHARS_PER_MESSAGE = 8000;

/** Ids that may appear on a command line; anything else gets no resume command. */
export const EXTERNAL_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isSafeExternalSessionId(sessionId: string): boolean {
  return EXTERNAL_SESSION_ID_PATTERN.test(sessionId);
}

export function buildExternalSessionKey(source: ExternalSessionSource, sessionId: string): string {
  return `${source}:${sessionId}`;
}

/** Quotes one POSIX shell argument; plain-safe values stay bare. */
export function quoteShellArgument(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The native tool's resume command for a session, or "" when the id is not shell-safe. */
export function buildExternalSessionResumeCommand(
  source: ExternalSessionSource,
  sessionId: string,
): string {
  if (!isSafeExternalSessionId(sessionId)) return "";
  switch (source) {
    case "claude":
      return `claude --resume ${sessionId}`;
    case "codex":
      return `codex resume ${sessionId}`;
    case "opencode":
      return `opencode --session ${sessionId}`;
    case "cursor":
      return `cursor-agent --resume ${sessionId}`;
    case "gemini":
      return `gemini --resume ${sessionId}`;
  }
}

/** Fallback title when the tool stored none and no user message was found. */
export function buildExternalSessionFallbackTitle(
  source: ExternalSessionSource,
  sessionId: string,
): string {
  return `${externalSessionSourceLabel(source)} · ${sessionId.slice(0, 8)}`;
}
