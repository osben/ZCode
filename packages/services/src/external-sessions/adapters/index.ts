import type { ExternalSessionSourceAdapter } from "#src/external-sessions/adapters/types.js";
import { claudeSessionsAdapter } from "#src/external-sessions/adapters/claude.js";
import { codexSessionsAdapter } from "#src/external-sessions/adapters/codex.js";
import { opencodeSessionsAdapter } from "#src/external-sessions/adapters/opencode.js";
import { cursorSessionsAdapter } from "#src/external-sessions/adapters/cursor.js";
import { geminiSessionsAdapter } from "#src/external-sessions/adapters/gemini.js";

/** Catalog order (specs/external-sessions.md "Sources"). */
export function createDefaultExternalSessionAdapters(): ExternalSessionSourceAdapter[] {
  return [
    claudeSessionsAdapter,
    codexSessionsAdapter,
    opencodeSessionsAdapter,
    cursorSessionsAdapter,
    geminiSessionsAdapter,
  ];
}
