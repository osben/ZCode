import { execFile } from "node:child_process";
import type { WindowsTaskkillRunner } from "./processTreeTypes.js";

export const defaultWindowsTaskkillRunner: WindowsTaskkillRunner = ({ force, pid, timeoutMs }) =>
  new Promise((resolve) => {
    // Synchronous taskkill blocks the Host serially by Agent count when multiple workspaces exit.
    // An async runner lets process trees shut down concurrently and lets the waiting state machine observe command completion.
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve({ ...(error ? { error } : {}), ...(stderr ? { stderr } : {}) });
      },
    );
  });
