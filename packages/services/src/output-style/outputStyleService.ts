import {
  BUILT_IN_OUTPUT_STYLES,
  outputStyleFilenameFromName,
  parseOutputStyleFile,
  safeOutputStyleFilenameFromId,
  type OutputStyle,
  type OutputStyleConfig,
} from "@zcode/shared";
import type { IOutputStyleService } from "./outputStyle.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const log = createServiceLogger("output-style");

const DEFAULT_OUTPUT_STYLE = "default";
const SETTINGS_FILE = "settings.json";

const BUILT_IN_STYLES: OutputStyle[] = BUILT_IN_OUTPUT_STYLES.map((style) => ({
  id: style.id,
  name: style.name,
  description: style.description,
  // The effective text for a built-in with no override file is the shared constant; an
  // override file with the same id replaces it (see listStyles).
  content: style.prompt,
  isBuiltIn: true,
  enabled: style.id === DEFAULT_OUTPUT_STYLE,
}));

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** Styles directory: ~/.zcode/output-styles (the only location; no legacy fallback). */
function getUserOutputStylesDir(): string {
  return join(resolveUserHomeDir(), ".zcode", "output-styles");
}

/** Settings path: ~/.zcode/settings.json (also stores the active style id). */
function getUserSettingsPath(): string {
  return join(resolveUserHomeDir(), ".zcode", SETTINGS_FILE);
}

interface SettingsFileShape {
  outputStyle?: string;
  [key: string]: unknown;
}

/**
 * Read JSON file safely
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    // Missing or unreadable settings mean no active style.
    return null;
  }
}

/**
 * Write JSON file safely
 */
async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function readCustomStyleFiles(dir: string): Promise<OutputStyle[]> {
  const styles: OutputStyle[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    // The directory does not exist or is unreadable; treat as no custom styles.
    return styles;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    try {
      const raw = await readFile(filePath, "utf-8");
      const { name, description, prompt } = parseOutputStyleFile(raw, entry.name);
      styles.push({
        id: `custom-${entry.name.replace(/\.md$/, "")}`,
        name,
        description,
        // Expose the parsed prompt body, not the raw file, so consumers always see the effective text.
        content: prompt,
        isBuiltIn: false,
        enabled: false,
        filePath,
      });
    } catch (error) {
      // A single unreadable style file is recoverable (it is skipped); log and continue.
      log.warn("Failed to read output style file", {
        file: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return styles;
}

/**
 * Create an OutputStyle service instance
 */
export function createOutputStyleService(): IOutputStyleService {
  async function getActiveStyle(): Promise<{ styleId: string | null }> {
    const settings = await readJsonFile<SettingsFileShape>(getUserSettingsPath());
    return { styleId: settings?.outputStyle ?? null };
  }

  async function setActiveStyle(params: { styleId: string }): Promise<void> {
    const { styleId } = params;
    const settingsPath = getUserSettingsPath();
    const settingsDir = join(resolveUserHomeDir(), ".zcode");

    await mkdir(settingsDir, { recursive: true });

    const existingSettings = (await readJsonFile<SettingsFileShape>(settingsPath)) || {};
    await writeJsonFile(settingsPath, {
      ...existingSettings,
      outputStyle: styleId,
    });
  }

  async function listStyles(): Promise<{ styles: OutputStyle[] }> {
    const { styleId } = await getActiveStyle();
    const activeStyleId = styleId ?? DEFAULT_OUTPUT_STYLE;

    const customStyles = await readCustomStyleFiles(getUserOutputStylesDir());

    // A file named after a built-in id overrides that built-in's constant (the runtime loader
    // resolves files the same way). Fold it into the built-in entry instead of listing a
    // duplicate custom row, so the list shows one card with the effective text.
    const builtInIds = new Set(BUILT_IN_OUTPUT_STYLES.map((style) => style.id));
    const overrides = new Map<string, OutputStyle>();
    const plainCustomStyles: OutputStyle[] = [];
    for (const style of customStyles) {
      const baseId = style.id.replace(/^custom-/, "");
      if (builtInIds.has(baseId)) {
        if (!overrides.has(baseId)) overrides.set(baseId, style);
      } else {
        plainCustomStyles.push(style);
      }
    }
    plainCustomStyles.sort((a, b) => a.name.localeCompare(b.name));

    const allStyles: OutputStyle[] = [
      ...BUILT_IN_STYLES.map((style) => {
        const override = overrides.get(style.id);
        return {
          ...style,
          ...(override
            ? {
                name: override.name,
                description: override.description,
                content: override.content,
                filePath: override.filePath,
                isOverridden: true,
              }
            : {}),
          enabled: style.id === activeStyleId,
        };
      }),
      ...plainCustomStyles.map((style) => ({
        ...style,
        enabled: style.id === activeStyleId,
      })),
    ];

    return { styles: allStyles };
  }

  async function addStyle(params: { config: OutputStyleConfig }): Promise<void> {
    const { config } = params;
    const stylesDir = getUserOutputStylesDir();

    // The filename is sanitized (shared helper), so a crafted name cannot traverse out of
    // the styles directory.
    const filename = outputStyleFilenameFromName(config.name);
    if (filename === "default.md") {
      // "default" means "no style" to the runtime loader; an override file for it could
      // never take effect, so refuse the write instead of creating a dead file.
      throw new Error('A style named "default" would shadow the reserved "no style" id');
    }

    await mkdir(stylesDir, { recursive: true });

    const filePath = join(stylesDir, filename);

    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    await writeFile(filePath, content, "utf-8");
  }

  async function updateStyle(params: { id: string; config: OutputStyleConfig }): Promise<void> {
    const { id, config } = params;

    // Updating a built-in id writes an override file next to the constants; deleting that
    // file restores the built-in text.
    const filename = safeOutputStyleFilenameFromId(id);
    const stylesDir = getUserOutputStylesDir();
    const filePath = join(stylesDir, filename);

    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    await mkdir(stylesDir, { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  async function deleteStyle(params: { id: string }): Promise<void> {
    const { id } = params;

    const filename = safeOutputStyleFilenameFromId(id);
    const stylesDir = getUserOutputStylesDir();
    const filePath = join(stylesDir, filename);

    await rm(filePath, { force: true });
  }

  async function getUserStylesDirectory(): Promise<{ path: string }> {
    // Pure path computation: reading the location must not create the directory on disk
    // (writes mkdir on their own, and merely opening Settings should stay side-effect free).
    return { path: getUserOutputStylesDir() };
  }

  return {
    listStyles,
    addStyle,
    updateStyle,
    deleteStyle,
    getUserStylesDirectory,
    setActiveStyle,
    getActiveStyle,
  };
}
