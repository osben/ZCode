// ============================================================
// LspService: the core entry point for the LSP tool, prewarm and post-edit diagnostics (spec §4-§7)
// ============================================================
// Owners:
//   - processes, capabilities, restarts: LanguageServerPort (adapter);
//   - open documents, versions, freshness: LspDocumentSync;
//   - queries for the tool: query-runner.ts;
//   - edits waiting for an attachment: EditDiagnosticsTracker.

import {
  LspError,
  type FileMutatedEvent,
  type FileSystemPort,
  type LanguageServerEvent,
  type LanguageServerKey,
  type LanguageServerPort,
  type LspDiagnostic,
  type LspInput,
  type LspOperation,
  type LspOutput,
  type LspPreferences,
  type Logger,
  type ResolvedLspServer,
} from "@zcode/contracts";
import {
  LSP_EDIT_DIAGNOSTICS_LOG_EVENT,
  LSP_EDIT_DIAGNOSTICS_MAX,
  LSP_EDIT_DIAGNOSTICS_MAX_CARRY_ROUNDS,
  LSP_EDIT_DIAGNOSTICS_WAIT_MS,
  LSP_LOG_MODULE,
  LSP_MAX_OPEN_DOCUMENTS,
} from "./constants.js";
import type { DiagnosticsMode } from "./diagnostics-freshness.js";
import { buildEditReport, EditDiagnosticsTracker, type ResolvedEdit } from "./edit-diagnostics.js";
import { LspDocumentSync, syncContextFor, type FreshnessEvent } from "./document-sync.js";
import { FreshnessWaiters } from "./freshness-waiters.js";
import { runLspQuery, type QueryContext } from "./query-runner.js";
import { LspServerRegistry } from "./registry.js";
import { toFileUri } from "./uri.js";

export interface LspServiceOptions {
  port: LanguageServerPort;
  servers: ResolvedLspServer[];
  key: LanguageServerKey;
  fileSystem: FileSystemPort;
  getPreferences(): LspPreferences;
  logger?: Logger;
  now?(): number;
}

export type LspQueryContext = QueryContext;

function sameServerKey(left: LanguageServerKey, right: LanguageServerKey): boolean {
  return left.identityKey === right.identityKey && left.workspacePath === right.workspacePath;
}

export interface EditDiagnosticsRequest {
  signal?: AbortSignal;
  /** Overrides LSP_EDIT_DIAGNOSTICS_WAIT_MS; measured from the last mutation. */
  waitMs?: number;
}

export interface EditDiagnosticsResult {
  attachmentBody?: string;
}

const WARN_EVENT = "core.lsp.warn";

export class LspService {
  private readonly registry: LspServerRegistry;
  private readonly sync: LspDocumentSync;
  private readonly tracker = new EditDiagnosticsTracker();
  private readonly waiters = new FreshnessWaiters();
  private readonly modes = new Map<string, DiagnosticsMode>();
  private readonly unsubscribeEvents: () => void;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: LspServiceOptions) {
    this.registry = new LspServerRegistry(options.servers);
    this.now = options.now ?? Date.now;
    this.sync = new LspDocumentSync({
      fileSystem: options.fileSystem,
      maxOpenDocuments: LSP_MAX_OPEN_DOCUMENTS,
      logger: options.logger,
      onFresh: (event: FreshnessEvent) => {
        this.modes.set(event.serverId, event.mode);
        this.waiters.notify();
      },
    });
    this.unsubscribeEvents = options.port.onEvent((event) => this.onServerEvent(event));
  }

  /** Whether the feature is enabled and at least one configured server binary is installed. */
  async isAvailable(): Promise<boolean> {
    if (this.disposed || !this.options.getPreferences().enabled) return false;
    for (const server of this.registry.servers()) {
      if (await this.options.port.isInstalled(server)) return true;
    }
    return false;
  }

  /** Stops every server when the feature is globally disabled (called by the runtime's preference update). */
  async shutdownIfDisabled(): Promise<void> {
    if (!this.options.getPreferences().enabled) await this.options.port.stopAll();
  }

  /** Last diagnostics mode observed for a server (pull, versioned, attributed), or unknown. */
  observedDiagnosticsMode(serverId: string): DiagnosticsMode | "unknown" {
    return this.modes.get(serverId) ?? "unknown";
  }

  /** Acquire only: starts the server for a file in a language without waiting for it. */
  prewarm(filePath: string): void {
    if (this.disposed || !this.options.getPreferences().enabled) return;
    const match = this.registry.forFile(filePath);
    if (!match) return;
    try {
      this.options.port.acquire(match.server, this.options.key);
    } catch (error) {
      this.warn("prewarm", error, match.server.id);
    }
  }

  /** Publishes a file mutation from Write or Edit. Returns immediately; the sync runs in the background. */
  onFileMutated(event: FileMutatedEvent): void {
    if (this.disposed || !this.options.getPreferences().enabled) return;
    const match = this.registry.forFile(event.path);
    if (!match) return;
    const diagnostics = this.diagnosticsAfterEdit(match.server);

    if (event.kind === "deleted") {
      this.tracker.remove(event.path);
    } else if (diagnostics) {
      // Recorded synchronously so that an attachment collected right after the tool result cannot miss it.
      this.tracker.recordSyncing({
        path: event.path,
        uri: toFileUri(event.path),
        serverId: match.server.id,
        changedRange: event.changedRange,
        at: this.now(),
      });
    }

    this.runMutation(match.server, match.languageId, event, diagnostics)
      .catch((error: unknown) => {
        // A failed sync must not leave the edit "syncing" forever, or every later attachment would wait the full bound.
        this.tracker.remove(event.path);
        this.warn("mutation", error, match.server.id);
      })
      .finally(() => this.waiters.notify());
  }

  /** Runs one LSP operation for the tool. Errors are LspError with a stable code. */
  query(
    operation: LspOperation,
    input: LspInput,
    context: LspQueryContext = {},
  ): Promise<LspOutput> {
    return runLspQuery(
      {
        registry: this.registry,
        port: this.options.port,
        key: this.options.key,
        fileSystem: this.options.fileSystem,
        sync: this.sync,
        waiters: this.waiters,
        assertEnabled: () => this.assertEnabled(),
      },
      operation,
      input,
      context,
    );
  }

  /** Diagnostics for one file: `ok` only when fresh for the current version, otherwise `pending`. */
  diagnostics(filePath: string, context: LspQueryContext = {}): Promise<LspOutput> {
    return this.query("diagnostics", { operation: "diagnostics", filePath }, context);
  }

  /**
   * Post-edit diagnostics for the next model request. Returns at once when no file was mutated
   * since the last request. Otherwise waits until pending files are fresh, bounded by waitMs from the
   * last mutation and by the abort signal (no polling). Files still pending on expiry are carried.
   */
  async collectEditDiagnostics(
    request: EditDiagnosticsRequest = {},
  ): Promise<EditDiagnosticsResult> {
    if (this.disposed || !this.options.getPreferences().enabled) {
      this.tracker.clear();
      return {};
    }
    if (this.tracker.size === 0) return {};

    const startedAt = this.now();
    const waitMs = request.waitMs ?? LSP_EDIT_DIAGNOSTICS_WAIT_MS;
    const deadline = (this.tracker.lastMutation ?? startedAt) + waitMs;
    await this.waiters.wait(
      () => this.tracker.entries().every((entry) => this.freshItemsFor(entry) !== undefined),
      deadline - this.now(),
      request.signal,
    );

    const resolved: ResolvedEdit[] = [];
    let pendingCount = 0;
    for (const entry of this.tracker.entries()) {
      const current = this.freshItemsFor(entry);
      if (current !== undefined) {
        resolved.push({ entry, current });
        this.tracker.remove(entry.path);
        continue;
      }
      entry.carriedRounds += 1;
      if (entry.carriedRounds > LSP_EDIT_DIAGNOSTICS_MAX_CARRY_ROUNDS) {
        this.tracker.remove(entry.path);
      } else {
        pendingCount += 1;
      }
    }

    const report = buildEditReport({
      resolved,
      pendingCount,
      workspacePath: this.options.key.workspacePath,
      maxItems: LSP_EDIT_DIAGNOSTICS_MAX,
    });
    if (report.body === undefined) return {};

    this.options.logger?.info("Post-edit diagnostics attached", {
      event: LSP_EDIT_DIAGNOSTICS_LOG_EVENT,
      module: LSP_LOG_MODULE,
      serverIds: report.serverIds,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      latencyMs: this.now() - startedAt,
      noBaseline: report.noBaseline,
    });
    return { attachmentBody: report.body };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEvents();
    this.sync.dispose();
    this.tracker.clear();
    this.waiters.notify();
  }

  private async runMutation(
    server: ResolvedLspServer,
    languageId: string,
    event: FileMutatedEvent,
    diagnostics: boolean,
  ): Promise<void> {
    const acquired = this.options.port.acquire(server, this.options.key);
    if (acquired.state === "failed") {
      // A failed server never publishes; keeping the edit would only report "pending" for the carry rounds.
      this.tracker.remove(event.path);
      return;
    }
    if (acquired.state === "starting") {
      if (diagnostics && event.kind !== "deleted") this.tracker.markNeedsSync(event.path);
      return;
    }
    const context = syncContextFor({ server, languageId }, this.options.key, acquired.connection);
    this.sync.notifyWatchedFile(context, event);
    const outcome = await this.sync.applyMutation(context, event);
    if (diagnostics && event.kind !== "deleted") this.tracker.settle(event.path, outcome.baseline);
  }

  /** Fresh diagnostics of a pending edit, or undefined while it is syncing or not fresh. */
  private freshItemsFor(entry: {
    serverId: string;
    uri: string;
    syncing: boolean;
    needsSync: boolean;
  }): LspDiagnostic[] | undefined {
    if (entry.syncing || entry.needsSync) return undefined;
    const document = this.sync.peekDocument(entry.serverId, this.options.key, entry.uri);
    return document?.freshness.currentFresh()?.items;
  }

  /** Replays edits made while the server was starting, once it is ready (spec §5: startup never blocks). */
  private async onServerEvent(event: LanguageServerEvent): Promise<void> {
    if (event.type !== "ready" || this.disposed) return;
    // The pool is process-wide, so a ready event may belong to another workspace's process with the same
    // server id. Replaying onto it would open this session's files in the wrong root.
    if (!sameServerKey(event.key, this.options.key)) return;
    const pending = this.tracker
      .entries()
      .filter((entry) => entry.needsSync && entry.serverId === event.serverId);
    for (const entry of pending) {
      const match = this.registry.forFile(entry.path);
      if (!match) continue;
      try {
        await this.sync.ensureOpen(
          syncContextFor(match, this.options.key, event.connection),
          entry.path,
        );
        this.tracker.settle(entry.path, undefined);
      } catch (error) {
        this.warn("replay", error, event.serverId);
        this.tracker.remove(entry.path);
      }
    }
    this.waiters.notify();
  }

  private diagnosticsAfterEdit(server: ResolvedLspServer): boolean {
    const preference = this.options.getPreferences().diagnosticsAfterEdit[server.id];
    return preference ?? server.diagnosticsAfterEdit;
  }

  private assertEnabled(): void {
    if (this.disposed || !this.options.getPreferences().enabled) {
      throw new LspError("lsp_disabled", "Code intelligence is turned off");
    }
  }

  private warn(operation: string, error: unknown, serverId: string): void {
    this.options.logger?.warn("LSP background operation failed", {
      event: WARN_EVENT,
      module: LSP_LOG_MODULE,
      operation,
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
