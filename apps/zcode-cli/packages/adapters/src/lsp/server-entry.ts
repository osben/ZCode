import type {
  LanguageServerKey,
  LanguageServerState,
  LspErrorCode,
  ResolvedLspServer,
} from "@zcode/contracts";
import type { TraceContext } from "@zcode/contracts";
import type { LspServerConnection } from "./server-connection.js";
import type { LspServerProcess } from "./server-process.js";

/** Pool bookkeeping for one (server id, identity, workspace) key. Owned by `pool.ts` and lifecycle code. */
export interface LspServerEntry {
  readonly poolKey: string;
  key: LanguageServerKey;
  server: ResolvedLspServer;
  state: LanguageServerState;
  /** Restarts performed after crashes; reported in status. */
  restarts: number;
  lastUsedAt: number;
  lastErrorCode?: LspErrorCode;
  lastErrorMessage?: string;
  notInstalledAt?: number;
  process?: LspServerProcess;
  connection?: LspServerConnection;
  /** Set while a graceful stop is running; acquire reports `starting` until it finishes. */
  stopping?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Trace of the acquire that started the current process; carried into its lifecycle logs. */
  traceContext?: TraceContext;
}

export function createServerEntry(
  poolKey: string,
  key: LanguageServerKey,
  server: ResolvedLspServer,
  now: number,
): LspServerEntry {
  return {
    poolKey,
    key,
    server,
    state: "stopped",
    restarts: 0,
    lastUsedAt: now,
  };
}

/** Structured trace fields for lifecycle logs. Background start work stays attributable to its caller. */
export function traceLogFields(trace: TraceContext | undefined): Record<string, string> {
  if (!trace) return {};
  const fields: Record<string, string> = { traceId: trace.traceId };
  if (trace.sessionId) fields.sessionId = trace.sessionId;
  if (trace.spanId) fields.spanId = trace.spanId;
  return fields;
}
