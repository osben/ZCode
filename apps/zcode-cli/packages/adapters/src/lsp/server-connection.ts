import type {
  LanguageServerConnection,
  LanguageServerKey,
  LanguageServerRequestOptions,
  ResolvedLspServer,
} from "@zcode/contracts";
import { LSP_METHOD_PULL_DIAGNOSTICS } from "./constants.js";
import type { LspServerProcess } from "./server-process.js";

/**
 * The handle handed to callers. It is bound to one process: after a restart, old handles reject with
 * `lsp_server_crashed` and callers re-acquire to obtain the new one.
 */
export class LspServerConnection implements LanguageServerConnection {
  constructor(
    private readonly process: LspServerProcess,
    private readonly touch: () => void,
  ) {}

  get server(): ResolvedLspServer {
    return this.process.server;
  }

  get key(): LanguageServerKey {
    return this.process.key;
  }

  get capabilities(): Readonly<Record<string, unknown>> {
    const capabilities: Record<string, unknown> = { ...this.process.initializeCapabilities };
    const pull = this.process.registry.optionsFor(LSP_METHOD_PULL_DIAGNOSTICS);
    if (pull) capabilities.diagnosticProvider = pull.options;
    return capabilities;
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    options?: LanguageServerRequestOptions,
  ): Promise<T> {
    this.touch();
    const serverTimeoutMs = this.process.server.requestTimeoutMs;
    const timeoutMs =
      options?.timeoutMs === undefined
        ? serverTimeoutMs
        : Math.min(options.timeoutMs, serverTimeoutMs);
    return this.process.rpc.sendRequest<T>(method, params, {
      signal: options?.signal,
      timeoutMs,
      timeoutCode: "lsp_request_timeout",
    });
  }

  notify(method: string, params: unknown): void {
    this.touch();
    this.process.rpc.notify(method, params);
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    return this.process.rpc.subscribe(method, handler);
  }
}
