// Process-wide LSP composition: one LanguageServerPort and one preferences store per CLI process,
// shared by every session runtime (spec 19-lsp.md §3-§4). Session runtimes register here so a
// preferences change reaches all of them without a restart.
import type {
  LanguageServerPort,
  LanguageServerStatus,
  LanguageServerState,
  LspPreferences,
  Logger,
  ResolvedLspServer,
} from "@zcode/contracts";
import type { ZCodeLspStatusResult } from "@zcode/shared";
import type { LspDocumentSync } from "@zcode/core";
import type { LspProtocolHost } from "../zcode-protocol/lsp.js";
import type { LspPreferencesStore } from "./lsp-preferences.js";

export interface LspRuntimeParticipant {
  applyLspPreferences(): Promise<void>;
}

export interface LspRuntimeHub {
  readonly port: LanguageServerPort;
  /** The single owner of open documents for every session on this port (spec §4). */
  readonly documents: LspDocumentSync;
  readonly preferences: LspPreferencesStore;
  readonly protocolHost: LspProtocolHost;
  register(participant: LspRuntimeParticipant): () => void;
}

export interface CreateLspRuntimeHubOptions {
  port: LanguageServerPort;
  documents: LspDocumentSync;
  preferences: LspPreferencesStore;
  /** Servers declared by enabled plugins for a workspace; must not start anything. */
  resolveServers(workspacePath: string): ResolvedLspServer[];
  logger?: Logger;
}

export function createLspRuntimeHub(options: CreateLspRuntimeHubOptions): LspRuntimeHub {
  const participants = new Set<LspRuntimeParticipant>();
  const { port, preferences, logger } = options;

  const protocolHost: LspProtocolHost = {
    preferences,
    async getStatus(workspace) {
      const prefs = await preferences.load();
      const servers = options.resolveServers(workspace.workspacePath);
      const live = port.status().filter((entry) => entry.workspacePath === workspace.workspacePath);
      const entries = await Promise.all(
        servers.map(async (server) => {
          const installed = await port.isInstalled(server);
          const running = live.find((entry) => entry.serverId === server.id);
          return toStatusEntry(server, prefs, installed, running);
        }),
      );
      return { enabled: prefs.enabled, servers: entries };
    },
    async applyPreferences(prefs) {
      if (!prefs.enabled) await port.stopAll();
      const results = await Promise.allSettled(
        [...participants].map((participant) => participant.applyLspPreferences()),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          logger?.warn("Applying LSP preferences to a session runtime failed", {
            event: "bootstrap.lsp.apply_preferences_failed",
            module: "bootstrap.lsp",
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    },
  };

  return {
    port,
    documents: options.documents,
    preferences,
    protocolHost,
    register(participant) {
      participants.add(participant);
      return () => {
        participants.delete(participant);
      };
    },
  };
}

function toStatusEntry(
  server: ResolvedLspServer,
  prefs: LspPreferences,
  installed: boolean,
  running: LanguageServerStatus | undefined,
): ZCodeLspStatusResult["servers"][number] {
  const state: LanguageServerState = running?.state ?? (installed ? "stopped" : "not_installed");
  return {
    serverId: server.id,
    pluginId: server.pluginId,
    serverName: server.serverName,
    command: server.command,
    extensions: Object.keys(server.extensionToLanguage),
    installed,
    state,
    diagnosticsMode: running?.diagnosticsMode ?? "unknown",
    diagnosticsAfterEdit: prefs.diagnosticsAfterEdit[server.id] ?? server.diagnosticsAfterEdit,
    restarts: running?.restarts ?? 0,
    ...(running?.lastErrorCode ? { lastErrorCode: running.lastErrorCode } : {}),
  };
}
