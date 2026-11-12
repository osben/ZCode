// macOS Electron locale whitelist and packaged-app guard.
//
// electron-builder matches electronLanguages against locale basenames. On macOS
// those are Electron Framework's *.lproj directories (en, zh_CN), not the
// Windows/Linux locales/*.pak names (en-US, zh-CN). A mismatch silently strips
// every lproj and Chromium's built-in strings (video controls menu) disappear.
import { existsSync } from "node:fs";
import { join } from "node:path";

// Fork ships the uk-UA locale, so uk.lproj must survive packaging alongside en and zh_CN.
export const MAC_ELECTRON_LANGUAGES = ["en", "zh_CN", "uk"];

export function resolveMacElectronFrameworkResourcesDir(appPath) {
  return join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Resources");
}

export function findMissingMacElectronLocales(
  frameworkResourcesDir,
  languages = MAC_ELECTRON_LANGUAGES,
) {
  return languages.filter(
    (language) => !existsSync(join(frameworkResourcesDir, `${language}.lproj`)),
  );
}
