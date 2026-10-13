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
import { join } from "node:path";

import { SYSTEM_PROMPT_OVERRIDE_KEYS, type SystemPromptOverrides } from "@zcode/shared";

const SYSTEM_PROMPT_DIR_NAME = "system-prompt";

export async function loadPersistedSystemPromptOverrides(input: {
  storageRoot: string;
}): Promise<SystemPromptOverrides> {
  const overrides: Record<string, string> = {};
  await Promise.all(
    SYSTEM_PROMPT_OVERRIDE_KEYS.map(async (key) => {
      try {
        const raw = await readFile(
          join(input.storageRoot, SYSTEM_PROMPT_DIR_NAME, `${key}.md`),
          "utf-8",
        );
        const trimmed = raw.trim();
        if (trimmed) {
          overrides[key] = trimmed;
        }
      } catch {
        // No override file for this key; the code default stays effective.
      }
    }),
  );
  return overrides;
}
