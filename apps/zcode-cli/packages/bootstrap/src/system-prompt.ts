// ============================================================
// Persisted system-prompt overrides loader
// (docs/system-prompt-overrides.md)
// ============================================================
//
// Reads ~/.zcode/system-prompt/<key>.md for each whitelisted section key. A present,
// non-empty file overrides that section's code default for new sessions; absent or
// whitespace-only files keep the constant. Keys are a fixed whitelist, so there is no
// user-derived filename and no traversal surface.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@zcode/contracts";
import { SYSTEM_PROMPT_OVERRIDE_KEYS, type SystemPromptOverrides } from "@zcode/shared";

const SYSTEM_PROMPT_DIR_NAME = "system-prompt";

// Override files live under $HOME/.zcode regardless of config.storage.dir, following the same
// rule as the global ~/.zcode/AGENTS.md lookup (adapters/src/context). The host-side
// systemPromptService cannot see the CLI's resolved storage config, so a fixed home-based
// location is what keeps the service's writes and this loader's reads on the same directory
// even when storage is redirected (ZCODE_STORAGE_DIR / storage.dir / beta default).
function resolveUserHomeDir(env: NodeJS.ProcessEnv): string {
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export async function loadPersistedSystemPromptOverrides(input: {
  env: NodeJS.ProcessEnv;
  logger?: Logger;
}): Promise<SystemPromptOverrides> {
  const overrides: Record<string, string> = {};
  const overridesDir = join(resolveUserHomeDir(input.env), ".zcode", SYSTEM_PROMPT_DIR_NAME);
  await Promise.all(
    SYSTEM_PROMPT_OVERRIDE_KEYS.map(async (key) => {
      try {
        const raw = await readFile(join(overridesDir, `${key}.md`), "utf-8");
        const trimmed = raw.trim();
        if (trimmed) {
          overrides[key] = trimmed;
        }
      } catch (error) {
        // ENOENT is the normal "override file absent" case; anything else (permissions, IO)
        // is worth a warning while still degrading to the code default, mirroring the
        // output-style loader's read discipline.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          input.logger?.warn("[SystemPrompt] Failed to read override file", {
            file: `${key}.md`,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );
  return overrides;
}
