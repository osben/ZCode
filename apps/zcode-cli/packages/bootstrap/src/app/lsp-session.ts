// Per-session LSP wiring: builds the session's LspService on top of the process-wide hub
// (protocol mode) or a private hub owned by this app (plain CLI runs).
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createLanguageServerPool } from "@zcode/adapters/lsp";
import type { FileSystemPort, Logger, ResolvedLspServer } from "@zcode/contracts";
import { createLspService, type LspService } from "@zcode/core";
import { createLspPreferencesStore } from "./lsp-preferences.js";
import {
  createLspRuntimeHub,
  type LspRuntimeHub,
  type LspRuntimeParticipant,
} from "./lsp-runtime-hub.js";

export interface SessionLsp {
  readonly service?: LspService;
  /** Registers the runtime for preference changes and applies the persisted preferences once. */
  attach(runtime: LspRuntimeParticipant): void;
  close(): Promise<void>;
}

export interface CreateSessionLspOptions {
  hub?: LspRuntimeHub;
  servers: ResolvedLspServer[];
  cliStorageRoot: string;
  fileSystemPort: FileSystemPort;
  /** Directory the session's tools operate in; becomes the server root. */
  workingDirectory: string;
  workspaceIdentity?: string;
  env: Record<string, string | undefined>;
  logger?: Logger;
}

export function createSessionLsp(options: CreateSessionLspOptions): SessionLsp {
  if (options.servers.length === 0) {
    return { attach: () => undefined, close: async () => undefined };
  }
  const ownedHub = options.hub
    ? undefined
    : createLspRuntimeHub({
        port: createLanguageServerPool({ baseEnv: options.env, logger: options.logger }),
        preferences: createLspPreferencesStore({
          cliStorageRoot: options.cliStorageRoot,
          fileSystem: createNodeFileSystemAdapter(),
          logger: options.logger,
        }),
        resolveServers: () => options.servers,
        logger: options.logger,
      });
  const hub = options.hub ?? ownedHub!;
  const service = createLspService({
    port: hub.port,
    servers: options.servers,
    key: {
      identityKey: options.workspaceIdentity?.trim() || options.workingDirectory,
      workspacePath: options.workingDirectory,
    },
    fileSystem: options.fileSystemPort,
    getPreferences: () => hub.preferences.get(),
    logger: options.logger,
  });
  let unregister: (() => void) | undefined;
  return {
    service,
    attach(runtime) {
      unregister = hub.register(runtime);
      // The runtime applies preferences at construction with defaults; re-apply once the sidecar is read.
      void hub.preferences
        .load()
        .then(() => runtime.applyLspPreferences())
        .catch((error: unknown) => {
          options.logger?.warn("Applying persisted LSP preferences failed", {
            event: "bootstrap.lsp.initial_preferences_failed",
            module: "bootstrap.lsp",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    async close() {
      unregister?.();
      try {
        await service.dispose();
      } finally {
        await ownedHub?.port.stopAll();
      }
    },
  };
}
