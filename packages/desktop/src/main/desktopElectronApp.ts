import { app } from "electron";
import { getAppConfigDir } from "@zcode/services/node";
import { DESKTOP_LOCAL_DEVELOPMENT_RUNTIME_ARG } from "@zcode/shared";

export function isElectronAppPackaged(): boolean {
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

/**
 * The single local-development signal of the desktop app: it selects the host's
 * `ZCODE_RUNTIME_ENV` and the renderer's `platform.isLocalDevelopmentRuntime`, so the two can
 * never disagree about dev-only surfaces. Packaged apps keep both closed.
 */
export function isDesktopLocalDevelopmentRuntime(): boolean {
  return !isElectronAppPackaged();
}

/** Preload `additionalArguments` for app renderer windows (main window and update window). */
export function buildAppRendererAdditionalArguments(deviceMid: string): string[] {
  return [
    `--device-id=${deviceMid}`,
    ...(isDesktopLocalDevelopmentRuntime() ? [DESKTOP_LOCAL_DEVELOPMENT_RUNTIME_ARG] : []),
  ];
}

export type ElectronAppPathName = "appData" | "userData";

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
