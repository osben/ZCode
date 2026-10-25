import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type UtilityProcess } from "electron";
import {
  HostMessageTypes,
  InternalChannels,
  databaseStartupControlSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { reportDatabaseStartupState } from "./databaseStartupTelemetry.js";

let localStorageReady = false;
let quit: (() => void) | undefined;
export function configureDatabaseStartupQuit(handler: () => void): void {
  quit = handler;
}
const readyListeners = new Set<() => void>();
/** Main schedules the existing scheduler only when Host is ready; it does not own migration state or its ledger. */
export function onLocalDatabaseStartupReady(listener: () => void): void {
  if (localStorageReady) listener();
  else readyListeners.add(listener);
}

const windowBindings = new WeakMap<BrowserWindow, () => void>();
const hostStartupIds = new WeakMap<UtilityProcess, string>();
export function getDatabaseStartupPortPayload(
  child: UtilityProcess,
): { databaseStartupId: string } | undefined {
  const databaseStartupId = hostStartupIds.get(child);
  return databaseStartupId ? { databaseStartupId } : undefined;
}

export function bindDatabaseStartupRelay(
  win: BrowserWindow,
  child: UtilityProcess,
  startupId = randomUUID(),
) {
  // When rebuilding Host in the same window, old listeners must not replay ready or receive user control commands.
  windowBindings.get(win)?.();
  hostStartupIds.set(child, startupId);
  let disposed = false;
  let latest: DatabaseStartupState | undefined;
  let exited = false;
  const forward = (state: DatabaseStartupState) => {
    if (!disposed && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send(InternalChannels.DatabaseStartupState, state);
  };
  const applyState = (state: DatabaseStartupState) => {
    if (latest && state.startupId === latest.startupId && state.sequence <= latest.sequence) return;
    latest = state;
    forward(state);
    try {
      reportDatabaseStartupState(state);
    } catch {
      /* Telemetry failures do not block startup. */
    }
    if (state.phase === "ready" && !localStorageReady) {
      localStorageReady = true;
      for (const listener of readyListeners) listener();
      readyListeners.clear();
    }
  };
  const receive = (state: DatabaseStartupState) => {
    if (disposed || exited || state.startupId !== startupId) return;
    applyState(state);
  };
  const control = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (disposed || event.sender !== win.webContents) return;
    const result = databaseStartupControlSchema.safeParse(raw);
    if (!result.success) return;
    if (result.data.action === "exit") {
      quit?.();
      return;
    }
    if (result.data.action === "snapshot" && latest) forward(latest);
    if (!exited)
      child.postMessage({ type: HostMessageTypes.DatabaseStartupControl, control: result.data });
  };
  const onExit = () => {
    exited = true;
    hostStartupIds.delete(child);
    if (!latest) {
      const now = Date.now();
      latest = {
        schemaVersion: 1,
        startupId,
        attemptId: randomUUID(),
        sequence: 0,
        startedAt: now,
        updatedAt: now,
        phase: "starting",
        disk: [],
      };
    }
    // Even if the previous generation was ready, a reload after exit can only observe failure; it cannot use the old proof to open a new port.
    if (latest.phase !== "failed")
      applyState({
        ...latest,
        sequence: latest.sequence + 1,
        updatedAt: Date.now(),
        failedPhase: latest.phase,
        phase: "failed",
        errorCode: "transport_closed",
      });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener(InternalChannels.DatabaseStartupControl, control);
    win.removeListener("closed", dispose);
    child.removeListener("exit", onExit);
    hostStartupIds.delete(child);
    if (windowBindings.get(win) === dispose) windowBindings.delete(win);
  };
  windowBindings.set(win, dispose);
  ipcMain.on(InternalChannels.DatabaseStartupControl, control);
  win.once("closed", dispose);
  child.once("exit", onExit);
  return { receive, startupId };
}
