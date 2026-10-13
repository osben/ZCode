import {
  SYSTEM_PROMPT_DEFAULTS,
  SYSTEM_PROMPT_OVERRIDE_KEYS,
  isSystemPromptOverrideKey,
} from "@zcode/shared";
import type { ISystemPromptService, SystemPromptSection } from "./systemPrompt.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** Override directory: ~/.zcode/system-prompt (the only location). */
function getOverridesDir(): string {
  return join(resolveUserHomeDir(), ".zcode", "system-prompt");
}

/** Key whitelist is the only filename source; unknown keys are rejected, not sanitized. */
function overrideFilePath(key: string): string | null {
  return isSystemPromptOverrideKey(key) ? join(getOverridesDir(), `${key}.md`) : null;
}

async function readOverride(key: string): Promise<string | null> {
  const filePath = overrideFilePath(key);
  if (!filePath) return null;
  try {
    const raw = await readFile(filePath, "utf-8");
    const trimmed = raw.trim();
    // Whitespace-only files are ignored, matching the CLI loader's semantics.
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Create a system-prompt override service. Defaults come from the shared constants, so the
 * UI shows exactly the text the runtime renders when no override file exists.
 */
export function createSystemPromptService(): ISystemPromptService {
  async function listSections(): Promise<{ sections: SystemPromptSection[] }> {
    const sections = await Promise.all(
      SYSTEM_PROMPT_OVERRIDE_KEYS.map(async (key) => {
        const overrideContent = await readOverride(key);
        return {
          key,
          defaultContent: SYSTEM_PROMPT_DEFAULTS[key],
          overrideContent,
          filePath: join(getOverridesDir(), `${key}.md`),
          isOverridden: overrideContent !== null,
        } satisfies SystemPromptSection;
      }),
    );
    return { sections };
  }

  async function writeOverride(params: { key: string; content: string }): Promise<void> {
    const filePath = overrideFilePath(params.key);
    if (!filePath) {
      throw new Error(`Unknown system-prompt override key: ${params.key}`);
    }
    await mkdir(getOverridesDir(), { recursive: true });
    await writeFile(filePath, params.content, "utf-8");
  }

  async function deleteOverride(params: { key: string }): Promise<void> {
    const filePath = overrideFilePath(params.key);
    if (!filePath) {
      throw new Error(`Unknown system-prompt override key: ${params.key}`);
    }
    await rm(filePath, { force: true });
  }

  async function getOverridesDirectory(): Promise<{ path: string }> {
    // Pure lookup: opening Settings must not materialize the directory.
    return { path: getOverridesDir() };
  }

  return {
    listSections,
    writeOverride,
    deleteOverride,
    getOverridesDirectory,
  };
}
