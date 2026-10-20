import { execFileSync } from "node:child_process";

import { buildWindowsTaskkillArgs, listE2EProcessTreePids } from "./e2e-process-cleanup.js";
import { reloadE2EElectronServiceBridge } from "./e2e-electron-service-lifecycle.js";

export interface E2EElectronProcessExitOptions {
  afterElectronProcessExit?: () => Promise<void> | void;
  cleanupTimedOutProcessTreePids?: (pids: number[]) => Promise<void> | void;
  collectProcessTreePids?: (rootPids?: number[]) => number[];
  delay?: (ms: number) => Promise<void>;
  forceKillGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  pollIntervalMs?: number;
  reloadElectronServiceBridge?: (browser: WebdriverIO.Browser) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_ELECTRON_EXIT_TIMEOUT_MS = 15_000;
const DEFAULT_ELECTRON_EXIT_POLL_INTERVAL_MS = 100;
const DEFAULT_ELECTRON_FORCE_KILL_GRACE_MS = 3_000;

interface PendingElectronExitBarrier {
  consumed: boolean;
  error: unknown;
  wait: () => Promise<void>;
}

const browsersWithDeleteBarrier = new WeakSet<WebdriverIO.Browser>();
const pendingExitBarrierByBrowser = new WeakMap<WebdriverIO.Browser, PendingElectronExitBarrier>();

export async function reloadElectronSessionSafely(
  browser: WebdriverIO.Browser,
  options: E2EElectronProcessExitOptions = {},
) {
  const oldElectronPid = await browser.electron.execute(async (electron) => {
    // Bug cause: WebDriver closes the windows before ending the old Electron; if DOM Storage has not been flushed
    // yet, a restart with the same userData still gets an empty localStorage. Flush explicitly first so the
    // "preserve profile" cold-recovery cases observe persistence consistent with a real normal exit.
    await electron.session.defaultSession.flushStorageData();
    const appPid = process.pid;
    let quitRequested = false;
    const requestQuit = () => {
      if (quitRequested) return;
      quitRequested = true;
      electron.app.quit();
    };
    const appWindows = electron.BrowserWindow.getAllWindows();
    for (const appWindow of appWindows) {
      appWindow.once("closed", requestQuit);
    }
    if (appWindows.length === 0) {
      setTimeout(requestQuit, 0);
    }
    return appPid;
  });
  const collectProcessTreePids = options.collectProcessTreePids ?? collectCurrentE2EProcessTreePids;
  const oldElectronProcessTreePids = normalizeProcessPids(collectProcessTreePids([oldElectronPid]));
  if (!oldElectronProcessTreePids.includes(oldElectronPid)) {
    throw new Error(
      `Electron reload 旧进程树未包含 main pid: pid=${oldElectronPid}, tree=${oldElectronProcessTreePids.join(",") || "empty"}`,
    );
  }

  // Bug root cause: waiting only on the main PID misses renderer/GPU/utility and spawned host/agent processes; the
  // full process tree must be captured by runId/HOME before deleteSession, and the same identity confirmed at zero
  // before the new session is created. deleteSession by default shuts ChromeDriver down too; only an explicit
  // shutdownDriver=false keeps the driver, and lets a barrier failure directly block the subsequent reloadSession
  // instead of being swallowed by WDIO while a new session is still created.
  ensureDeleteSessionExitBarrier(browser);
  const pendingBarrier: PendingElectronExitBarrier = {
    consumed: false,
    error: null,
    wait: () =>
      waitForElectronProcessExit(oldElectronProcessTreePids, {
        ...options,
        collectProcessTreePids,
      }),
  };
  pendingExitBarrierByBrowser.set(browser, pendingBarrier);

  try {
    try {
      await browser.deleteSession({ shutdownDriver: false });
    } catch (error) {
      if (pendingBarrier.error) {
        throw new Error("Electron reload 旧进程退出屏障失败", {
          cause: pendingBarrier.error,
        });
      }
      throw error;
    }
    if (!pendingBarrier.consumed) {
      throw new Error("Electron reload 未经过旧进程退出屏障");
    }
    if (pendingBarrier.error) {
      throw new Error("Electron reload 旧进程退出屏障失败", { cause: pendingBarrier.error });
    }

    // Bug root cause: a running Host flushes asynchronously and writes back provider/config data; if the test direct
    // seeds while the old process is alive, the same isolated HOME still gets overwritten by the old snapshot. Only
    // after the exit barrier completes and before the new process starts is there a deterministic window without
    // concurrent writers.
    await options.afterElectronProcessExit?.();

    // reloadSession deletes the already-closed old protocol session again and swallows the invalid-session error;
    // ChromeDriver is still alive, so afterwards only a new protocol session is created, never crossing the process
    // tree barrier above.
    const newSessionId = await browser.reloadSession();
    // Bug root cause: after the new WebDriver session is established, Electron service.before does not rerun
    // automatically; the helper must wait for the new main process's CDP bridge to be rebuilt and pass the probe
    // before returning to the caller.
    await (options.reloadElectronServiceBridge ?? reloadE2EElectronServiceBridge)(browser);
    return newSessionId;
  } finally {
    pendingExitBarrierByBrowser.delete(browser);
  }
}

/** Fully restarts Electron while explicitly reusing the same userData, so an empty profile does not mask recovery behavior. */
export async function reloadElectronSessionPreservingBrowserProfile(
  browser: WebdriverIO.Browser,
  options: E2EElectronProcessExitOptions = {},
): Promise<string> {
  const userDataDir = (await browser.electron.execute((electron) =>
    electron.app.getPath("userData"),
  )) as string;
  const requestedCapabilities = browser.requestedCapabilities as WebdriverIO.Capabilities & {
    "goog:chromeOptions"?: { args?: string[] };
  };
  const chromeOptions = requestedCapabilities["goog:chromeOptions"] ?? {};
  requestedCapabilities["goog:chromeOptions"] = {
    ...chromeOptions,
    args: [
      ...(chromeOptions.args ?? []).filter((arg) => !arg.startsWith("--user-data-dir=")),
      `--user-data-dir=${userDataDir}`,
    ],
  };
  await reloadElectronSessionSafely(browser, options);
  return (await browser.electron.execute((electron) => electron.app.getPath("userData"))) as string;
}

function ensureDeleteSessionExitBarrier(browser: WebdriverIO.Browser) {
  if (browsersWithDeleteBarrier.has(browser)) return;

  const overwriteDeleteSession = async function (
    this: WebdriverIO.Browser,
    originalDeleteSession: (...deleteArgs: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ) {
    const pendingBarrier = pendingExitBarrierByBrowser.get(this);
    let deleteFailed = false;
    let deleteError: unknown = null;
    let deleteResult: unknown = null;
    try {
      deleteResult = await originalDeleteSession(...args);
    } catch (error) {
      deleteFailed = true;
      deleteError = error;
    }
    if (pendingBarrier) {
      pendingExitBarrierByBrowser.delete(this);
      pendingBarrier.consumed = true;
      try {
        await pendingBarrier.wait();
      } catch (error) {
        pendingBarrier.error = error;
        throw error;
      }
    }
    if (deleteFailed) throw deleteError;
    return deleteResult;
  };
  // WebdriverIO's public runtime allows overriding protocol commands, but the 9.x types only list browser commands;
  // the cast here is narrowed to the verified deleteSession wrapper and not spread to other commands.
  browser.overwriteCommand("deleteSession" as never, overwriteDeleteSession as never);
  browsersWithDeleteBarrier.add(browser);
}

export async function waitForElectronProcessExit(
  pidOrPids: number | number[],
  options: E2EElectronProcessExitOptions = {},
) {
  const trackedPids = normalizeProcessPids(Array.isArray(pidOrPids) ? pidOrPids : [pidOrPids]);
  const cleanupTimedOutProcessTreePids =
    options.cleanupTimedOutProcessTreePids ??
    ((pids: number[]) => cleanupTimedOutElectronProcessTreePids(pids, options));
  const collectProcessTreePids = options.collectProcessTreePids ?? (() => []);
  const delay = options.delay ?? defaultDelay;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ELECTRON_EXIT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ELECTRON_EXIT_TIMEOUT_MS;
  const forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_ELECTRON_FORCE_KILL_GRACE_MS;
  const waitOptions = {
    collectProcessTreePids,
    delay,
    isProcessAlive,
    now,
    pollIntervalMs,
  };
  let remainingPids = await waitForProcessTreeExit(trackedPids, timeoutMs, waitOptions);
  if (remainingPids.length === 0) return;

  // Reason for the fix: after the natural-exit timeout, reloadSession must not go on building a new session with the
  // old resources; reuse the runner's Windows taskkill /T /F and POSIX TERM -> KILL approach, then do a strict
  // identity rescan afterwards.
  await cleanupTimedOutProcessTreePids(remainingPids);
  remainingPids = await waitForProcessTreeExit(trackedPids, forceKillGraceMs, waitOptions);
  if (remainingPids.length === 0) return;

  throw new Error(
    `Electron reload 旧进程树退出超时: pids=${remainingPids.join(",")}, timeoutMs=${timeoutMs}`,
  );
}

interface ProcessTreeWaitOptions {
  collectProcessTreePids: () => number[];
  delay: (ms: number) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
  pollIntervalMs: number;
}

async function waitForProcessTreeExit(
  trackedPids: number[],
  timeoutMs: number,
  options: ProcessTreeWaitOptions,
) {
  const startedAt = options.now();
  while (true) {
    const remainingPids = getRemainingProcessTreePids(trackedPids, options);
    if (remainingPids.length === 0 || options.now() - startedAt >= timeoutMs) {
      return remainingPids;
    }
    await options.delay(options.pollIntervalMs);
  }
}

function getRemainingProcessTreePids(
  trackedPids: number[],
  options: Pick<ProcessTreeWaitOptions, "collectProcessTreePids" | "isProcessAlive">,
) {
  return normalizeProcessPids([...trackedPids, ...options.collectProcessTreePids()]).filter(
    options.isProcessAlive,
  );
}

async function cleanupTimedOutElectronProcessTreePids(
  pids: number[],
  options: E2EElectronProcessExitOptions,
) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", buildWindowsTaskkillArgs(pids), {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // taskkill may return non-zero because some PIDs exited naturally; the final identity rescan is responsible
      // for reporting real residue.
    }
    return;
  }

  signalPosixProcesses(pids, "SIGTERM");
  const forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_ELECTRON_FORCE_KILL_GRACE_MS;
  const remainingAfterTerm = await waitForProcessTreeExit(pids, forceKillGraceMs, {
    collectProcessTreePids: () => [],
    delay: options.delay ?? defaultDelay,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    now: options.now ?? Date.now,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_ELECTRON_EXIT_POLL_INTERVAL_MS,
  });
  signalPosixProcesses(remainingAfterTerm, "SIGKILL");
}

function signalPosixProcesses(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may exit naturally before the signal is delivered; the final identity rescan decides whether the
      // barrier succeeded.
    }
  }
}

function collectCurrentE2EProcessTreePids(rootPids: number[] = []) {
  const homeDir = process.env.ZCODE_E2E_HOME_DIR?.trim();
  const runId = process.env.ZCODE_E2E_RUN_ID?.trim();
  if (!homeDir || !runId) {
    throw new Error("Electron reload 缺少 ZCODE_E2E_HOME_DIR 或 ZCODE_E2E_RUN_ID");
  }
  return listE2EProcessTreePids({
    currentPid: process.pid,
    homeDir,
    // reloadSession reuses the still-alive ChromeDriver; including it in the old Electron's exit barrier makes
    // deleteSession({ shutdownDriver: false }) and the barrier semantics conflict, ending in ECONNREFUSED.
    includeChromeDriverAncestors: false,
    rootPids,
    runId,
  });
}

function normalizeProcessPids(pids: number[]) {
  return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
}

function defaultDelay(ms: number) {
  return new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, Math.max(ms, 0));
  });
}

function defaultIsProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code !== "ESRCH",
    );
  }
}
