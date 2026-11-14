import type {
  ExternalSessionSource,
  ExternalSessionSummary,
  ExternalSessionTranscriptMessage,
} from "#src/external-sessions/contract.js";

/** Everything an adapter may depend on; tests inject a temp home. */
export interface ExternalSessionScanContext {
  homeDir: string;
  /** Extra data roots to probe in addition to homeDir (ZCODE_DATA_BASE_DIR style); may be empty. */
  extraHomeDirs?: readonly string[];
  now: () => number;
  warn: (message: string, error?: unknown) => void;
}

export interface ExternalSessionTranscriptRead {
  messages: ExternalSessionTranscriptMessage[];
  truncated: boolean;
}

/**
 * One source = one stateless adapter. `list` returns every non-subagent session the source knows
 * (summary fields only, bounded reads); `readTranscript` reads one body lazily and returns null
 * when the session is unknown. Throwing from `list` marks the whole source unavailable; one bad
 * session file must be skipped with `ctx.warn` instead.
 */
export interface ExternalSessionSourceAdapter {
  source: ExternalSessionSource;
  list(ctx: ExternalSessionScanContext): Promise<ExternalSessionSummary[]>;
  readTranscript(
    ctx: ExternalSessionScanContext,
    summary: ExternalSessionSummary,
  ): Promise<ExternalSessionTranscriptRead | null>;
}
