// ============================================================
// Persisted output style loader (files-as-contract, see
// docs/output-styles-settings.md)
// ============================================================
//
// The active output style lives on disk so the settings UI and the agent runtime share one
// source of truth without a protocol field:
//   - active id:   <storageRoot>/settings.json { "outputStyle": "<id>" }
//                  (~/.claude/settings.json is a read-only legacy fallback)
//   - prompt text: <storageRoot>/output-styles/<id>.md
//                  (~/.claude/output-styles/ is a read-only legacy fallback)
//   - a file with a built-in id overrides the shared constant for that id
//
// Absent id, "default", or an empty resolved prompt returns undefined, which keeps the
// stock system prompt byte-identical.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeConfig } from "@zcode/core";
import { BUILT_IN_OUTPUT_STYLES, parseOutputStyleFile } from "@zcode/shared";

const LEGACY_CLAUDE_DIR = ".claude";
const OUTPUT_STYLES_DIR_NAME = "output-styles";
const SETTINGS_FILE = "settings.json";
const CUSTOM_ID_PREFIX = "custom-";
const DEFAULT_STYLE_ID = "default";

async function readActiveStyleId(settingsPaths: readonly string[]): Promise<string | undefined> {
  for (const settingsPath of settingsPaths) {
    try {
      const raw = await readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as { outputStyle?: unknown };
      if (typeof parsed.outputStyle === "string" && parsed.outputStyle.trim()) {
        return parsed.outputStyle.trim();
      }
    } catch {
      // Missing or invalid settings fall through to the next source.
    }
  }
  return undefined;
}

async function readStyleFile(stylePaths: readonly string[]): Promise<string | null> {
  for (const stylePath of stylePaths) {
    try {
      return await readFile(stylePath, "utf-8");
    } catch {
      // Missing file falls through to the next source.
    }
  }
  return null;
}

/**
 * Resolve the persisted output style for a new session. `storageRoot` is the CLI user
 * storage root (`~/.zcode`); legacy paths are derived from the same home directory.
 */
export async function loadPersistedOutputStyle(input: {
  storageRoot: string;
}): Promise<AgentRuntimeConfig["outputStyle"]> {
  const storageRoot = input.storageRoot;
  const styleId = await readActiveStyleId([
    join(storageRoot, SETTINGS_FILE),
    join(homedir(), LEGACY_CLAUDE_DIR, SETTINGS_FILE),
  ]);
  if (!styleId || styleId === DEFAULT_STYLE_ID) return undefined;

  const filename = `${styleId.startsWith(CUSTOM_ID_PREFIX) ? styleId.slice(CUSTOM_ID_PREFIX.length) : styleId}.md`;
  const fileContent = await readStyleFile([
    join(storageRoot, OUTPUT_STYLES_DIR_NAME, filename),
    join(homedir(), LEGACY_CLAUDE_DIR, OUTPUT_STYLES_DIR_NAME, filename),
  ]);
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
