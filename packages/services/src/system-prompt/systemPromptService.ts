import {
  SYSTEM_PROMPT_DEFAULTS,
  SYSTEM_PROMPT_OVERRIDE_KEYS,
  isSystemPromptOverrideKey,
} from "@zcode/shared";
import type { ISystemPromptService, SystemPromptSection } from "./systemPrompt.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const log = createServiceLogger("system-prompt");

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
  } catch (error) {
    // ENOENT is the normal "no override" case; other read failures (permissions, IO) stay
    // visible instead of silently degrading the section to its code default. Mirrors the
    // output-style service's read discipline.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("Failed to read system-prompt override file", {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    // Rename within the overrides directory is atomic, so a concurrent runtime reader (new
    // CLI session) never observes a truncated file; a direct writeFile would expose the
    // partial override mid-write.
    const tempPath = join(getOverridesDir(), `.${params.key}.md.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, params.content, "utf-8");
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
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
