import { app } from "electron";
import { getAppConfigDir } from "@zcode/services/node";

type ElectronAppPathName = "appData" | "userData";

export function isElectronAppPackaged(): boolean {
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

export function getElectronAppPath(name: ElectronAppPathName): string {
  const electronApp = app as unknown as
    | { getPath?: (pathName: ElectronAppPathName) => string }
    | undefined;
  if (electronApp?.getPath) {
    return electronApp.getPath(name);
  }

  // Some main-process tests mock only the Electron APIs directly needed by the module under test,
  // so app may be unavailable when desktopRuntimeEnv is imported indirectly. Real desktop runs still use app.getPath;
  // Node-only tests fall back to the config directory so an import-time constant does not break unrelated tests.
  return getAppConfigDir();
}
