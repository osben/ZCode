// ============================================================
// LspDocumentSync: single owner of open documents per (serverId, pool key) (spec §4-§6)
// ============================================================
// Responsibilities: didOpen/didChange/didClose, drift detection (mtime+size), LRU cap,
// publishDiagnostics handling and pull diagnostics. Files are read only through FileSystemPort.
// Diagnostics freshness rules live in diagnostics-freshness.ts; this class only feeds them.

import type {
  FileMutatedEvent,
  FileSystemPort,
  LanguageServerConnection,
  LanguageServerKey,
  LspDiagnostic,
  Logger,
  ResolvedLspServer,
  TraceContext,
} from "@zcode/contracts";
import { LSP_FILE_CHANGE_TYPE, LSP_METHODS } from "./constants.js";
import { DiagnosticsFreshness, type DiagnosticsMode } from "./diagnostics-freshness.js";
import { normalizeRawDiagnostics, type RawLspDiagnostic } from "./diagnostics.js";
import { OpenDocumentStore, type DocumentSnapshot, type OpenDocument } from "./document-store.js";
import { normalizeFileUri, toFileUri } from "./uri.js";
import { splitLines } from "./position.js";
import { KeyedLock } from "./keyed-lock.js";

const INITIAL_DOCUMENT_VERSION = 1;
const DEBUG_PULL_FAILED = "LSP pull diagnostics failed";
const TEXT_ENCODER = new TextEncoder();

export interface SyncContext {
  server: ResolvedLspServer;
  key: LanguageServerKey;
  connection: LanguageServerConnection;
  languageId: string;
  signal?: AbortSignal;
  trace?: TraceContext;
}

/** Builds the sync context for one connection from a registry match. */
export function syncContextFor(
  match: { server: ResolvedLspServer; languageId: string },
  key: LanguageServerKey,
  connection: LanguageServerConnection,
  context: { signal?: AbortSignal; trace?: TraceContext } = {},
): SyncContext {
  return {
    server: match.server,
    key,
    connection,
    languageId: match.languageId,
    signal: context.signal,
    trace: context.trace,
  };
}

export interface MutationOutcome {
  /** Last fresh diagnostics before this edit; undefined when the document was not open. */
  baseline?: LspDiagnostic[];
  /** Whether the server was given a change (didOpen or didChange). */
  synced: boolean;
}

export interface FreshnessEvent {
  serverId: string;
  uri: string;
  mode: DiagnosticsMode;
}

export interface DocumentSyncOptions {
  fileSystem: FileSystemPort;
  maxOpenDocuments: number;
  logger?: Logger;
  onFresh(event: FreshnessEvent): void;
}

interface StoreEntry {
  connection: LanguageServerConnection;
  store: OpenDocumentStore;
  unsubscribe: () => void;
}

export class LspDocumentSync {
  private readonly stores = new Map<string, StoreEntry>();
  private readonly locks = new KeyedLock();

  constructor(private readonly options: DocumentSyncOptions) {}

  /** Opens the document or refreshes it when it drifted on disk. Returns the live document. */
  async ensureOpen(context: SyncContext, filePath: string): Promise<OpenDocument> {
    const uri = toFileUri(filePath);
    return this.locks.run(lockKey(context, uri), async () => {
      const store = this.storeFor(context);
      const existing = store.touch(uri);
      if (existing) {
        await this.refreshIfDrifted(context, existing);
        return existing;
      }
      const read = await this.readFromDisk(context, filePath);
      return this.openWithContent(context, store, filePath, uri, read);
    });
  }

  /**
   * Applies a FileMutated event: didChange for an open document, didOpen otherwise, didClose
   * on deletion. The baseline is captured before the change, so it is the last fresh result
   * for the content the model saw before its edit.
   */
  async applyMutation(context: SyncContext, event: FileMutatedEvent): Promise<MutationOutcome> {
    const uri = toFileUri(event.path);
    return this.locks.run(lockKey(context, uri), async () => {
      const store = this.storeFor(context);
      if (event.kind === "deleted") {
        const removed = store.delete(uri);
        if (removed) {
          context.connection.notify(LSP_METHODS.didClose, { textDocument: { uri } });
        }
        return { synced: removed !== undefined };
      }

      const content = event.content ?? (await this.readFromDisk(context, event.path)).content;
      const snapshot = await this.snapshotOf(context, event.path, content);
      const existing = store.touch(uri);
      if (existing) {
        const baseline = existing.freshness.lastFresh?.items;
        existing.snapshot = snapshot;
        if (existing.text === content) return { baseline, synced: false };
        this.applyChange(context, existing, content);
        return { baseline, synced: true };
      }
      this.openWithContent(context, store, event.path, uri, { content, snapshot });
      return { baseline: undefined, synced: true };
    });
  }

  /** didChangeWatchedFiles for a mutation, so servers with file watchers (gopls, rust-analyzer) see it. */
  notifyWatchedFile(context: SyncContext, event: FileMutatedEvent): void {
    const type =
      event.kind === "created"
        ? LSP_FILE_CHANGE_TYPE.created
        : event.kind === "deleted"
          ? LSP_FILE_CHANGE_TYPE.deleted
          : LSP_FILE_CHANGE_TYPE.changed;
    context.connection.notify(LSP_METHODS.didChangeWatchedFiles, {
      changes: [{ uri: toFileUri(event.path), type }],
    });
  }

  /** Requests a pull diagnostic for the document's current version when the server supports it. */
  requestPull(context: SyncContext, document: OpenDocument): Promise<void> {
    if (!context.connection.capabilities.diagnosticProvider) return Promise.resolve();
    const version = document.freshness.version;
    const lines = document.lines;
    return context.connection
      .request<unknown>(
        LSP_METHODS.pullDiagnostics,
        { textDocument: { uri: document.uri } },
        { signal: context.signal },
      )
      .then((result) => {
        const items = pullItems(result);
        if (items === undefined) return;
        const normalized = normalizeRawDiagnostics(document.path, lines, items);
        if (document.freshness.recordPull(version, normalized) === "fresh") {
          this.options.onFresh({
            serverId: context.server.id,
            uri: document.uri,
            mode: "pull",
          });
        }
      })
      .catch(() => {
        this.options.logger?.debug(DEBUG_PULL_FAILED, {
          event: "core.lsp.pull_failed",
          module: "core.lsp",
          serverId: context.server.id,
        });
      });
  }

  /** Live document for a server and pool key, without changing LRU order. */
  peekDocument(serverId: string, key: LanguageServerKey, uri: string): OpenDocument | undefined {
    return this.stores.get(poolKey(serverId, key))?.store.peek(uri);
  }

  dispose(): void {
    for (const entry of this.stores.values()) entry.unsubscribe();
    this.stores.clear();
  }

  private storeFor(context: SyncContext): OpenDocumentStore {
    const storeKey = poolKey(context.server.id, context.key);
    const current = this.stores.get(storeKey);
    if (current && current.connection === context.connection) return current.store;
    current?.unsubscribe();

    const store = new OpenDocumentStore(this.options.maxOpenDocuments);
    const unsubscribe = context.connection.onNotification(
      LSP_METHODS.publishDiagnostics,
      (params) => this.handlePublish(context.server.id, store, params),
    );
    this.stores.set(storeKey, { connection: context.connection, store, unsubscribe });
    return store;
  }

  private handlePublish(serverId: string, store: OpenDocumentStore, params: unknown): void {
    if (!isRecord(params) || typeof params.uri !== "string") return;
    const uri = normalizeFileUri(params.uri);
    const document = store.peek(uri);
    if (!document) return;
    const version = typeof params.version === "number" ? params.version : undefined;
    const raw = Array.isArray(params.diagnostics) ? (params.diagnostics as RawLspDiagnostic[]) : [];
    const items = normalizeRawDiagnostics(document.path, document.lines, raw);
    const outcome = document.freshness.recordPublish({ version, items });
    if (outcome === "fresh") {
      this.options.onFresh({
        serverId,
        uri,
        mode: document.freshness.lastFresh?.mode ?? "versioned",
      });
    }
  }

  private async refreshIfDrifted(context: SyncContext, document: OpenDocument): Promise<void> {
    const stat = await this.options.fileSystem.stat(
      { path: document.path, trace: context.trace },
      { signal: context.signal },
    );
    const unchanged =
      stat.mtimeMs !== undefined &&
      stat.mtimeMs === document.snapshot.mtimeMs &&
      stat.sizeBytes === document.snapshot.sizeBytes;
    if (unchanged) return;

    const read = await this.readFromDisk(context, document.path);
    document.snapshot = { sizeBytes: stat.sizeBytes, mtimeMs: stat.mtimeMs };
    if (read.content !== document.text) this.applyChange(context, document, read.content);
  }

  private openWithContent(
    context: SyncContext,
    store: OpenDocumentStore,
    filePath: string,
    uri: string,
    read: DiskRead,
  ): OpenDocument {
    const document: OpenDocument = {
      uri,
      path: filePath,
      languageId: context.languageId,
      text: read.content,
      lines: splitLines(read.content),
      snapshot: read.snapshot,
      freshness: new DiagnosticsFreshness<LspDiagnostic[]>(),
    };
    document.freshness.recordChange(INITIAL_DOCUMENT_VERSION);
    for (const evicted of store.insert(document)) {
      context.connection.notify(LSP_METHODS.didClose, { textDocument: { uri: evicted.uri } });
    }
    context.connection.notify(LSP_METHODS.didOpen, {
      textDocument: {
        uri,
        languageId: context.languageId,
        version: INITIAL_DOCUMENT_VERSION,
        text: read.content,
      },
    });
    void this.requestPull(context, document);
    return document;
  }

  private applyChange(context: SyncContext, document: OpenDocument, text: string): void {
    document.text = text;
    document.lines = splitLines(text);
    const version = document.freshness.version + 1;
    document.freshness.recordChange(version);
    context.connection.notify(LSP_METHODS.didChange, {
      textDocument: { uri: document.uri, version },
      contentChanges: [{ text }],
    });
    void this.requestPull(context, document);
  }

  private async readFromDisk(context: SyncContext, filePath: string): Promise<DiskRead> {
    const stat = await this.options.fileSystem.stat(
      { path: filePath, trace: context.trace },
      { signal: context.signal },
    );
    const read = await this.options.fileSystem.readTextFile(
      { path: filePath, trace: context.trace },
      { signal: context.signal },
    );
    return {
      content: read.content,
      snapshot: { sizeBytes: stat.sizeBytes, mtimeMs: stat.mtimeMs },
    };
  }

  private async snapshotOf(
    context: SyncContext,
    filePath: string,
    content: string,
  ): Promise<DocumentSnapshot> {
    try {
      const stat = await this.options.fileSystem.stat(
        { path: filePath, trace: context.trace },
        { signal: context.signal },
      );
      return { sizeBytes: stat.sizeBytes, mtimeMs: stat.mtimeMs };
    } catch {
      // The file may have been removed between the write and this check; the content is still authoritative.
      return { sizeBytes: TEXT_ENCODER.encode(content).byteLength };
    }
  }
}

interface DiskRead {
  content: string;
  snapshot: DocumentSnapshot;
}

function pullItems(result: unknown): RawLspDiagnostic[] | undefined {
  if (!isRecord(result) || result.kind === "unchanged") return undefined;
  return Array.isArray(result.items) ? (result.items as RawLspDiagnostic[]) : [];
}

function poolKey(serverId: string, key: LanguageServerKey): string {
  return [serverId, key.identityKey, key.workspacePath].join("\u0000");
}

function lockKey(context: SyncContext, uri: string): string {
  return `${poolKey(context.server.id, context.key)}\u0000${uri}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
