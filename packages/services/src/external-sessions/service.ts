import { homedir } from "node:os";
import { z } from "zod";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { defaultOpenTerminal } from "#src/model-provider/acpAgentLogin.js";
import {
  EXTERNAL_SESSIONS_CACHE_TTL_MS,
  EXTERNAL_SESSIONS_DEFAULT_LIMIT,
  EXTERNAL_SESSIONS_MAX_LIMIT,
  EXTERNAL_SESSION_NOT_FOUND,
  EXTERNAL_SESSION_SOURCES,
  EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE,
  type ExternalSessionRef,
  type ExternalSessionSource,
  type ExternalSessionSourceStatus,
  type ExternalSessionSummary,
  type ExternalSessionsListParams,
  type ExternalSessionsListResult,
  type IExternalSessionsService,
} from "#src/external-sessions/contract.js";
import type {
  ExternalSessionScanContext,
  ExternalSessionSourceAdapter,
} from "#src/external-sessions/adapters/types.js";
import { normalizePathForComparison, pathExists } from "#src/external-sessions/adapters/shared.js";
import { buildResumeCommandLine } from "#src/external-sessions/terminal.js";

const logger = createServiceLogger("external-sessions");

const sourceSchema = z.enum(EXTERNAL_SESSION_SOURCES);
const listParamsSchema = z
  .object({
    workspacePath: z.string().trim().min(1).optional(),
    sources: z.array(sourceSchema).max(EXTERNAL_SESSION_SOURCES.length).optional(),
    search: z.string().max(200).optional(),
    limit: z.number().int().positive().max(EXTERNAL_SESSIONS_MAX_LIMIT).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();
const refSchema = z
  .object({ source: sourceSchema, sessionId: z.string().min(1).max(256) })
  .strict();

interface SourceCacheEntry {
  summaries: ExternalSessionSummary[];
  status: ExternalSessionSourceStatus;
  scannedAt: number;
}

export interface ExternalSessionsServiceOptions {
  adapters: readonly ExternalSessionSourceAdapter[];
  homeDir?: string;
  extraHomeDirs?: readonly string[];
  now?: () => number;
  cacheTtlMs?: number;
  openTerminal?: (commandLine: string) => Promise<{ opened: boolean; error?: string }>;
  platform?: NodeJS.Platform;
}

/**
 * Owner of the per-Host listing cache (specs/external-sessions.md "Contract"). Adapters are stateless; a
 * scan runs every adapter with allSettled so one broken store only marks its own source unavailable.
 */
export function createExternalSessionsService(
  options: ExternalSessionsServiceOptions,
): IExternalSessionsService {
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? EXTERNAL_SESSIONS_CACHE_TTL_MS;
  const openTerminal = options.openTerminal ?? defaultOpenTerminal;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const ctx: ExternalSessionScanContext = {
    homeDir,
    extraHomeDirs: options.extraHomeDirs ?? [],
    now,
    warn: (message, error) => logger.warn(undefined, message, error),
  };
  const adaptersBySource = new Map<ExternalSessionSource, ExternalSessionSourceAdapter>(
    options.adapters.map((adapter) => [adapter.source, adapter]),
  );
  const cache = new Map<ExternalSessionSource, SourceCacheEntry>();
  let inflight: Promise<void> | null = null;

  async function scanSource(adapter: ExternalSessionSourceAdapter): Promise<void> {
    const started = now();
    try {
      const summaries = await adapter.list(ctx);
      summaries.sort((left, right) => right.updatedAt - left.updatedAt);
      cache.set(adapter.source, {
        summaries,
        status: { available: true, count: summaries.length },
        scannedAt: now(),
      });
      logger.info(
        undefined,
        `external sessions scanned source=${adapter.source} count=${summaries.length} ms=${now() - started}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      cache.set(adapter.source, {
        summaries: [],
        status: { available: false, count: 0, reason },
        scannedAt: now(),
      });
      logger.warn(
        undefined,
        `external sessions source unavailable source=${adapter.source}`,
        error,
      );
    }
  }

  async function ensureFresh(
    sources: readonly ExternalSessionSource[],
    refresh: boolean,
  ): Promise<void> {
    const stale = sources.filter((source) => {
      const entry = cache.get(source);
      return refresh || !entry || now() - entry.scannedAt > cacheTtlMs;
    });
    if (stale.length === 0) return;
    if (inflight) await inflight;
    const stillStale = stale.filter((source) => {
      const entry = cache.get(source);
      return refresh || !entry || now() - entry.scannedAt > cacheTtlMs;
    });
    if (stillStale.length === 0) return;
    inflight = Promise.allSettled(
      stillStale.map((source) => {
        const adapter = adaptersBySource.get(source);
        return adapter ? scanSource(adapter) : Promise.resolve();
      }),
    ).then(() => undefined);
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  }

  function emptyStatuses(): Record<ExternalSessionSource, ExternalSessionSourceStatus> {
    return Object.fromEntries(
      EXTERNAL_SESSION_SOURCES.map((source) => [
        source,
        adaptersBySource.has(source)
          ? { available: false, count: 0, reason: "not scanned" }
          : { available: false, count: 0, reason: "no adapter" },
      ]),
    ) as Record<ExternalSessionSource, ExternalSessionSourceStatus>;
  }

  async function findSummary(ref: ExternalSessionRef): Promise<ExternalSessionSummary> {
    await ensureFresh([ref.source], false);
    let summary = cache.get(ref.source)?.summaries.find((item) => item.sessionId === ref.sessionId);
    if (!summary) {
      await ensureFresh([ref.source], true);
      summary = cache.get(ref.source)?.summaries.find((item) => item.sessionId === ref.sessionId);
    }
    if (!summary) throw new Error(EXTERNAL_SESSION_NOT_FOUND);
    return summary;
  }

  return {
    async listExternalSessions(
      rawParams: ExternalSessionsListParams,
    ): Promise<ExternalSessionsListResult> {
      const params = listParamsSchema.parse(rawParams ?? {});
      const requested = params.sources?.length
        ? params.sources.filter((source) => adaptersBySource.has(source))
        : [...adaptersBySource.keys()];
      await ensureFresh(requested, params.refresh === true);
      const statuses = emptyStatuses();
      const workspaceKey = params.workspacePath
        ? normalizePathForComparison(params.workspacePath)
        : null;
      const search = params.search?.trim().toLowerCase() ?? "";
      const merged: ExternalSessionSummary[] = [];
      let scannedAt = 0;
      for (const source of requested) {
        const entry = cache.get(source);
        if (!entry) continue;
        statuses[source] = entry.status;
        scannedAt = Math.max(scannedAt, entry.scannedAt);
        for (const summary of entry.summaries) {
          // No cwd means no workspace to match against, so the session is never listed for any workspace.
          if (!summary.workspacePath) continue;
          if (
            workspaceKey !== null &&
            normalizePathForComparison(summary.workspacePath) !== workspaceKey
          ) {
            continue;
          }
          if (
            search &&
            !summary.title.toLowerCase().includes(search) &&
            !summary.sessionId.toLowerCase().includes(search)
          ) {
            continue;
          }
          merged.push(summary);
        }
      }
      merged.sort((left, right) => right.updatedAt - left.updatedAt);
      const limit = params.limit ?? EXTERNAL_SESSIONS_DEFAULT_LIMIT;
      return { sessions: merged.slice(0, limit), sources: statuses, scannedAt };
    },

    async readExternalSessionTranscript(rawRef) {
      const ref = refSchema.parse(rawRef);
      const summary = await findSummary(ref);
      if (!summary.transcriptAvailable) throw new Error(EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE);
      const adapter = adaptersBySource.get(ref.source);
      const read = adapter ? await adapter.readTranscript(ctx, summary) : null;
      if (!read) throw new Error(EXTERNAL_SESSION_NOT_FOUND);
      return { summary, messages: read.messages, truncated: read.truncated };
    },

    async openExternalSessionInTerminal(rawRef) {
      const ref = refSchema.parse(rawRef);
      const summary = await findSummary(ref);
      const cwd = (await pathExists(summary.workspacePath)) ? summary.workspacePath : homeDir;
      const command = buildResumeCommandLine({ cwd, resumeCommand: summary.resumeCommand });
      if (platform !== "darwin") {
        return {
          opened: false,
          command,
          error: "Opening a terminal window is only supported on macOS.",
        };
      }
      const result = await openTerminal(command);
      logger.info(
        undefined,
        `external session resume source=${ref.source} opened=${result.opened}`,
      );
      return { opened: result.opened, command, ...(result.error ? { error: result.error } : {}) };
    },
  };
}
