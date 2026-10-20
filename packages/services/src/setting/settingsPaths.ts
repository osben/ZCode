import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Settings file locations. Both files live at the default homedir location and follow the
 * Electron home override (`ZCODE_DESKTOP_HOME_DIR`), so isolated Desktop Dev instances write
 * isolated settings.
 */

function resolveUserHomeDir() {
  // An isolated Desktop Dev instance has its own home, but the settings service still wrote to the real HOME,
  // causing startup migration and appearance changes to affect other instances. Match Electron's explicit home override.
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export function getSettingsDir() {
  return join(resolveUserHomeDir(), ".zcode", "v2");
}

export function getSettingsFile() {
  return join(getSettingsDir(), "setting.json");
}

/**
 * Fork-only settings (see FORK_SETTING_KEYS in @zcode/shared) live in this sidecar file instead of
 * setting.json: the upstream app shares setting.json with this fork and strips every key its own
 * schema does not know, so anything fork-owned would be silently deleted by the next upstream
 * write. This file is never touched by upstream builds.
 */
export function getForkSettingsFile() {
  return join(getSettingsDir(), "fork-settings.json");
}

/** Concrete settings locations of one service instance, resolved once when it is created. */
export interface SettingsLocation {
  dir: string;
  file: string;
  forkFile: string;
}

/**
 * Pins the locations at service creation. Resolving HOME on every IO lets an older instance's
 * async read or write land in a later instance's home directory (see the settingService tests
 * that create several services with different HOME values).
 */
export function resolveSettingsLocation(): SettingsLocation {
  const dir = getSettingsDir();
  return { dir, file: join(dir, "setting.json"), forkFile: join(dir, "fork-settings.json") };
}
