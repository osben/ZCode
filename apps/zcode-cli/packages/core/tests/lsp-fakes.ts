// In-memory fakes for LSP tests: a language server port, a connection that records traffic,
// and a file system. No processes or real files are touched.

import {
  LspError,
  createFileSystemError,
  type FileSystemPort,
  type LanguageServerAcquireResult,
  type LanguageServerConnection,
  type LanguageServerEvent,
  type LanguageServerKey,
  type LanguageServerPort,
  type LanguageServerRequestOptions,
  type LspErrorCode,
  type LspPreferences,
  type ResolvedLspServer,
} from "@zcode/contracts";
import { toFileUri } from "../src/lsp/uri.js";

export const WORKSPACE = "/work/repo";
export const LSP_KEY: LanguageServerKey = { identityKey: "ws-1", workspacePath: WORKSPACE };

export function makeServer(overrides: Partial<ResolvedLspServer> = {}): ResolvedLspServer {
  return {
    id: "demo/ts",
    pluginId: "demo",
    serverName: "ts",
    priority: 0,
    command: "fake-ls",
    args: [],
    env: {},
    extensionToLanguage: { ".ts": "typescript", ".tsx": "typescriptreact" },
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
    requestTimeoutMs: 60_000,
    restartOnCrash: true,
    maxRestarts: 3,
    diagnosticsAfterEdit: true,
    ...overrides,
  };
}

export function makePreferences(overrides: Partial<LspPreferences> = {}): LspPreferences {
  return { version: 1, enabled: true, diagnosticsAfterEdit: {}, ...overrides };
}

export interface RecordedMessage {
  method: string;
  params: unknown;
}

export class FakeConnection implements LanguageServerConnection {
  readonly requests: RecordedMessage[] = [];
  readonly notifications: RecordedMessage[] = [];
  readonly responses = new Map<string, (params: unknown) => unknown>();
  /** Called synchronously after every notification; tests use it to publish diagnostics. */
  onNotify?: (message: RecordedMessage) => void;
  capabilities: Record<string, unknown>;
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(
    readonly server: ResolvedLspServer,
    readonly key: LanguageServerKey,
    capabilities: Record<string, unknown> = {
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
    },
  ) {
    this.capabilities = capabilities;
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    options?: LanguageServerRequestOptions,
  ): Promise<T> {
    void options;
    this.requests.push({ method, params });
    const handler = this.responses.get(method);
    if (!handler) {
      return Promise.reject(
        new LspError("lsp_operation_unsupported", `no fake response for ${method}`),
      );
    }
    return Promise.resolve(handler(params) as T);
  }

  notify(method: string, params: unknown): void {
    const message = { method, params };
    this.notifications.push(message);
    this.onNotify?.(message);
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /** Simulates a publishDiagnostics notification from the server. */
  publish(uri: string, diagnostics: unknown[], version?: number): void {
    const params: Record<string, unknown> = { uri, diagnostics };
    if (version !== undefined) params.version = version;
    for (const handler of this.listeners.get("textDocument/publishDiagnostics") ?? [])
      handler(params);
  }

  methods(method: string): RecordedMessage[] {
    return this.notifications.filter((message) => message.method === method);
  }
}

export class FakeLanguageServerPort implements LanguageServerPort {
  installed = true;
  state: "ready" | "starting" | "failed" = "ready";
  failure: { code: LspErrorCode; message: string } = {
    code: "lsp_server_start_failed",
    message: "boom",
  };
  stopAllCalls = 0;
  acquireCalls = 0;
  /** Connections created so far, newest last. A restart creates a new connection. */
  readonly connections: FakeConnection[] = [];
  /** Optional capability override for newly created connections. */
  capabilities?: Record<string, unknown>;
  private readonly listeners = new Set<(event: LanguageServerEvent) => void>();

  get connection(): FakeConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error("no connection was created");
    return connection;
  }

  acquire(server: ResolvedLspServer, key: LanguageServerKey): LanguageServerAcquireResult {
    this.acquireCalls += 1;
    if (this.state === "starting") return { state: "starting" };
    if (this.state === "failed") return { state: "failed", ...this.failure };
    if (this.connections.length === 0) {
      this.connections.push(new FakeConnection(server, key, this.capabilities));
    }
    return { state: "ready", connection: this.connection };
  }

  isInstalled(): Promise<boolean> {
    return Promise.resolve(this.installed);
  }

  onEvent(listener: (event: LanguageServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: LanguageServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Simulates a restart: the next acquire creates a fresh connection, then announces ready. */
  restart(server: ResolvedLspServer): FakeConnection {
    const connection = new FakeConnection(server, LSP_KEY, this.capabilities);
    this.connections.push(connection);
    this.state = "ready";
    this.emit({ type: "ready", serverId: server.id, key: LSP_KEY, connection });
    return connection;
  }

  status(): [] {
    return [];
  }

  stopAll(): Promise<void> {
    this.stopAllCalls += 1;
    return Promise.resolve();
  }
}

export interface MemoryFile {
  content: string;
  mtimeMs: number;
}

export class MemoryFileSystem {
  readonly files = new Map<string, MemoryFile>();
  readonly writes: { path: string; content: string }[] = [];
  private clock = 1;

  set(path: string, content: string): void {
    this.files.set(path, { content, mtimeMs: this.clock++ });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  stat(request: {
    path: string;
  }): Promise<{ path: string; kind: "file"; sizeBytes: number; mtimeMs: number }> {
    const file = this.files.get(request.path);
    if (!file)
      return Promise.reject(
        createFileSystemError({
          code: "not_found",
          message: "missing",
          path: request.path,
        } as never),
      );
    return Promise.resolve({
      path: request.path,
      kind: "file",
      sizeBytes: new TextEncoder().encode(file.content).byteLength,
      mtimeMs: file.mtimeMs,
    });
  }

  readTextFile(request: { path: string }): Promise<{
    path: string;
    content: string;
    encoding: "utf-8";
    lineEndings: "LF";
    bytesRead: number;
    sizeBytes: number;
    truncated: boolean;
  }> {
    const file = this.files.get(request.path);
    if (!file)
      return Promise.reject(
        createFileSystemError({
          code: "not_found",
          message: "missing",
          path: request.path,
        } as never),
      );
    const sizeBytes = new TextEncoder().encode(file.content).byteLength;
    return Promise.resolve({
      path: request.path,
      content: file.content,
      encoding: "utf-8",
      lineEndings: "LF",
      bytesRead: sizeBytes,
      sizeBytes,
      truncated: false,
    });
  }

  writeTextFile(request: {
    path: string;
    content: string;
  }): Promise<{ path: string; revision: undefined }> {
    this.writes.push({ path: request.path, content: request.content });
    this.set(request.path, request.content);
    return Promise.resolve({ path: request.path, revision: undefined });
  }

  asPort(): FileSystemPort {
    return this as unknown as FileSystemPort;
  }
}

export function fileUri(path: string): string {
  return toFileUri(path);
}

/** A raw LSP diagnostic on one 0-based line with the given span. */
export function rawDiagnostic(input: {
  line: number;
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
  startCharacter?: number;
  endCharacter?: number;
}): Record<string, unknown> {
  return {
    range: {
      start: { line: input.line, character: input.startCharacter ?? 0 },
      end: { line: input.line, character: input.endCharacter ?? 1 },
    },
    severity: input.severity ?? 1,
    message: input.message,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.source === undefined ? {} : { source: input.source }),
  };
}

/** Flushes pending promise continuations (fake timers do not advance by themselves). */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
