// ============================================================
// LspServerRegistry: file extension -> ResolvedLspServer (spec §2, §4)
// ============================================================
// Conflicts are already resolved by the plugin loader (one file maps to one server).
// The registry only indexes them. Exact extension match wins, then a case-insensitive match.

import { extname } from "node:path";
import type { ResolvedLspServer } from "@zcode/contracts";

export interface LspServerMatch {
  server: ResolvedLspServer;
  languageId: string;
}

export class LspServerRegistry {
  private readonly servers_: readonly ResolvedLspServer[];
  private readonly byExtension = new Map<string, LspServerMatch>();
  private readonly byLowerExtension = new Map<string, LspServerMatch>();
  private readonly byId = new Map<string, ResolvedLspServer>();

  constructor(servers: readonly ResolvedLspServer[]) {
    // Higher priority first, so when two entries claim one extension the stronger one is indexed first.
    const ordered = [...servers].sort(
      (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
    );
    this.servers_ = ordered;
    for (const server of ordered) {
      this.byId.set(server.id, server);
      for (const [extension, languageId] of Object.entries(server.extensionToLanguage)) {
        const match: LspServerMatch = { server, languageId };
        if (!this.byExtension.has(extension)) this.byExtension.set(extension, match);
        const lower = extension.toLowerCase();
        if (!this.byLowerExtension.has(lower)) this.byLowerExtension.set(lower, match);
      }
    }
  }

  forFile(filePath: string): LspServerMatch | undefined {
    const extension = extname(filePath);
    if (extension.length === 0) return undefined;
    return this.byExtension.get(extension) ?? this.byLowerExtension.get(extension.toLowerCase());
  }

  servers(): readonly ResolvedLspServer[] {
    return this.servers_;
  }

  get(serverId: string): ResolvedLspServer | undefined {
    return this.byId.get(serverId);
  }
}
