import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";

export function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // Inject dataBaseDir early in startup so logger / crashReporter do not first create directories under the default HOME,
    // which would leave logs and crash dumps in two different locations after switching to a custom directory.
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
