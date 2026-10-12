import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "./desktop-app.js";
import { reloadElectronSessionSafely } from "./e2e-electron-reload.js";
import { flushElectronStorageData } from "./e2e-electron-storage.js";

const paths = getE2EAppDataPaths();
const MODEL_SELECTION_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1:";
let retainedRestartUserDataDir: string | null = null;

export interface ModelProviderRestartOptions {
  afterElectronProcessExit?: () => Promise<void> | void;
}

export async function seedTurboAgentStartupModel(providerId: string, modelId: string) {
  // The default selection shares the same Personal file as the Provider, so seeding must preserve the existing model config.
  const repository = new NodePersonalProviderConfigRepository({
    filePath: paths.configFile,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      defaultModelSelection: { providerId, modelId },
    }));
  } finally {
    repository.dispose();
  }
}

export async function restartIntoWorkspacePreservingProfile(
  workspacePath: string,
  options: ModelProviderRestartOptions = {},
) {
  const isFirstRestart = retainedRestartUserDataDir === null;
  if (isFirstRestart) {
    retainedRestartUserDataDir = (await browser.electron.execute((electron) =>
      electron.app.getPath("userData"),
    )) as string;
  }
  const requestedCapabilities = browser.requestedCapabilities as WebdriverIO.Capabilities & {
    "goog:chromeOptions"?: { args?: string[] };
  };
  const chromeOptions = requestedCapabilities["goog:chromeOptions"] ?? {};
  requestedCapabilities["goog:chromeOptions"] = {
    ...chromeOptions,
    args: [
      ...(chromeOptions.args ?? []).filter((arg) => !arg.startsWith("--user-data-dir=")),
      `--user-data-dir=${retainedRestartUserDataDir}`,
    ],
  };

  // Bug root cause: the old implementation flushed only on the first restart; the second and third relied on a fixed pause, and process exit could
  // happen before Chromium flushed DOMStorage asynchronously, so the next case would restore the previous case's thoughtLevel.
  // The reload helper already rebuilds and probes the Electron service bridge after every new session, so every
  // exit must establish a real persistence barrier through the current bridge; a load-dependent sleep can no longer substitute.
  await flushElectronStorageData(browser);
  await reloadElectronSessionSafely(browser, {
    afterElectronProcessExit: options.afterElectronProcessExit,
  });
  // Bug root cause: a Puppeteer targetId is not guaranteed to also be a ChromeDriver window handle,
  // and switchToWindow(targetId) in long batches breaks the CDP bridge. Reuse the shared helper's
  // BrowserWindow URL + handle/target intersection switching to keep the same contract as the WDIO preflight.
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(workspacePath, 60000);
}

export async function restartIntoWorkspaceRestoringPreferences(
  workspacePath: string,
  options: ModelProviderRestartOptions = {},
) {
  const persistedModelPreferences = await browser.execute(
    (modelSelectionRecentKeyPrefix) =>
      Object.fromEntries(
        Object.entries(window.localStorage).filter(
          ([key]) =>
            key.startsWith("zcode-last-agent-") ||
            // Bug root cause: the restart helper restored only the old agent keys and missed the only currently structured
            // Model Selection recent key, so the cold-start assertion saw storedConfig=null and
            // fell back to preferredSelection. Both key families must be restored together after the same exit barrier.
            key.startsWith(modelSelectionRecentKeyPrefix),
        ),
      ),
    MODEL_SELECTION_RECENT_KEY_PREFIX,
  );
  // Bug root cause: if the SQLite/provider fixture is written while the old Host/Agent is still alive, late persistence
  // during the exit phase overwrites it. Only put the caller's writes inside the reload's process-exit barrier; do not guess timing with pauses.
  await reloadElectronSessionSafely(browser, {
    afterElectronProcessExit: options.afterElectronProcessExit,
  });
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(workspacePath, 60000);
  await browser.execute((preferences) => {
    for (const [key, value] of Object.entries(preferences)) {
      window.localStorage.setItem(key, value);
    }
    window.location.reload();
  }, persistedModelPreferences);
  // The generic fallback case needs the "pending preferences" restored after the new renderer starts; an invalid model
  // must not be written ahead of time as the Agent's launch model. They only verify preference fallback, not the first deferred session.
  await waitForWorkspaceApp(workspacePath, 60000);
}
