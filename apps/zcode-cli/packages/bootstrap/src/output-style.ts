// ============================================================
// Persisted output style loader (files-as-contract, see
// docs/output-styles-settings.md)
// ============================================================
//
// The active output style lives on disk so the settings UI and the agent runtime share one
// source of truth without a protocol field:
//   - active id:   <storageRoot>/settings.json { "outputStyle": "<id>" }
//   - prompt text: <storageRoot>/output-styles/<id>.md
//   - a file with a built-in id overrides the shared constant for that id
//
// Absent id, "default", or an empty resolved prompt returns undefined, which keeps the
// stock system prompt byte-identical.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger } from "@zcode/contracts";
import {
  BUILT_IN_OUTPUT_STYLES,
  parseOutputStyleFile,
  safeOutputStyleFilenameFromId,
} from "@zcode/shared";

const OUTPUT_STYLES_DIR_NAME = "output-styles";
const SETTINGS_FILE = "settings.json";
const DEFAULT_STYLE_ID = "default";

async function readActiveStyleId(settingsPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { outputStyle?: unknown };
    if (typeof parsed.outputStyle === "string" && parsed.outputStyle.trim()) {
      return parsed.outputStyle.trim();
    }
  } catch {
    // Missing or invalid settings mean no active style.
  }
  return undefined;
}

/**
 * Resolve the persisted output style for a new session. `storageRoot` is the CLI user
 * storage root (`~/.zcode`). `logger` receives non-ENOENT read warnings; the style
 * resolution itself always degrades to the built-in constant instead of failing startup.
 */
export async function loadPersistedOutputStyle(input: {
  storageRoot: string;
  logger?: Logger;
}): Promise<AgentRuntimeConfig["outputStyle"]> {
  const storageRoot = input.storageRoot;
  const styleId = await readActiveStyleId(join(storageRoot, SETTINGS_FILE));
  if (!styleId || styleId === DEFAULT_STYLE_ID) return undefined;

  // The id goes through the shared sanitizer, so a crafted settings entry cannot point the
  // read outside the styles directory.
  const filename = safeOutputStyleFilenameFromId(styleId);
  let fileContent: string | null = null;
  try {
    fileContent = await readFile(join(storageRoot, OUTPUT_STYLES_DIR_NAME, filename), "utf-8");
  } catch (error) {
    // ENOENT is the normal "override file absent" case; anything else (permissions, IO)
    // is worth a warning while still degrading to the built-in constant.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      input.logger?.warn("[OutputStyle] Failed to read style override file", {
        file: filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (fileContent !== null) {
    const parsed = parseOutputStyleFile(fileContent, filename);
    if (!parsed.prompt) return undefined;
    return { name: parsed.name, prompt: parsed.prompt };
  }

  const builtIn = BUILT_IN_OUTPUT_STYLES.find((style) => style.id === styleId);
  // An id that matches no built-in constant and no file resolves to nothing.
  if (!builtIn || builtIn.prompt === "") return undefined;
  return { name: builtIn.name, prompt: builtIn.prompt };
}
