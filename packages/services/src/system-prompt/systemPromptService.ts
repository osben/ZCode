import {
  SYSTEM_PROMPT_DEFAULTS,
  SYSTEM_PROMPT_OVERRIDE_KEYS,
  composeMemoryGuidanceDefault,
  isSystemPromptOverrideKey,
  normalizeSystemPromptText,
} from "@zcode/shared";
import { atomicWriteFile, withFileLock } from "@zcode/shared/node";
import type {
  ISystemPromptService,
  SystemPromptSection,
  SystemPromptWriteResult,
} from "./systemPrompt.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
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

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Revision of the current file bytes; null when the file is missing. Other read errors propagate. */
async function readRevision(filePath: string): Promise<string | null> {
  try {
    return hashBytes(await readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readOverride(
  key: string,
): Promise<{ content: string | null; revision: string | null }> {
  const filePath = overrideFilePath(key);
  if (!filePath) return { content: null, revision: null };
  try {
    const bytes = await readFile(filePath);
    const trimmed = normalizeSystemPromptText(bytes.toString("utf-8"));
    // Whitespace-only files are ignored, matching the CLI loader's semantics. The revision still
    // reflects the file bytes, so a save over such a file is checked like any other.
    return { content: trimmed ? trimmed : null, revision: hashBytes(bytes) };
  } catch (error) {
    // ENOENT is the normal "no override" case; other read failures (permissions, IO) stay
    // visible instead of silently degrading the section to its code default. Mirrors the
    // output-style service's read discipline.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(undefined, "Failed to read system-prompt override file", {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { content: null, revision: null };
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
        const { content: overrideContent, revision } = await readOverride(key);
        return {
          key,
          // The memory-guidance default must match what the runtime renders for the active
          // retrieval branch (default-index inserts the MEMORY.md index pointer paragraph),
          // or the Settings default/diff preview would disagree with the restored prompt.
          defaultContent:
            key === "memory-guidance"
              ? composeMemoryGuidanceDefault("default-index")
              : SYSTEM_PROMPT_DEFAULTS[key],
          overrideContent,
          filePath: join(getOverridesDir(), `${key}.md`),
          isOverridden: overrideContent !== null,
          revision,
        } satisfies SystemPromptSection;
      }),
    );
    return { sections };
  }

  async function writeOverride(params: {
    key: string;
    content: string;
    expectedRevision?: string | null;
  }): Promise<SystemPromptWriteResult> {
    const filePath = overrideFilePath(params.key);
    if (!filePath) {
      throw new Error(`Unknown system-prompt override key: ${params.key}`);
    }
    // Store the same trimmed text the readers return, so the stored bytes, the effective text and
    // the revision returned here all describe one value.
    const normalized = normalizeSystemPromptText(params.content);
    if (!normalized) {
      throw new Error(
        `System-prompt override for ${params.key} is empty; delete the override to restore the default`,
      );
    }
    const bytes = Buffer.from(normalized, "utf-8");
    return withFileLock(filePath, async (): Promise<SystemPromptWriteResult> => {
      await mkdir(getOverridesDir(), { recursive: true });
      if (params.expectedRevision !== undefined) {
        const currentRevision = await readRevision(filePath);
        if (currentRevision !== params.expectedRevision) {
          log.info(undefined, "[system-prompt] write rejected by revision conflict", {
            key: params.key,
            hasCurrentFile: currentRevision !== null,
          });
          return { kind: "conflict", currentRevision };
        }
      }
      // Atomic temp-file rename inside the overrides directory: a concurrent runtime reader
      // (new CLI session) never observes a truncated file.
      await atomicWriteFile(filePath, bytes);
      return { kind: "ok", revision: hashBytes(bytes) };
    });
  }

  async function deleteOverride(params: {
    key: string;
    expectedRevision?: string | null;
  }): Promise<SystemPromptWriteResult> {
    const filePath = overrideFilePath(params.key);
    if (!filePath) {
      throw new Error(`Unknown system-prompt override key: ${params.key}`);
    }
    return withFileLock(filePath, async (): Promise<SystemPromptWriteResult> => {
      if (params.expectedRevision !== undefined) {
        const currentRevision = await readRevision(filePath);
        if (currentRevision !== params.expectedRevision) {
          log.info(undefined, "[system-prompt] delete rejected by revision conflict", {
            key: params.key,
            hasCurrentFile: currentRevision !== null,
          });
          return { kind: "conflict", currentRevision };
        }
      }
      await rm(filePath, { force: true });
      return { kind: "ok", revision: null };
    });
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
