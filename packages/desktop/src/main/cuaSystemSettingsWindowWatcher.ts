/**
 * System Settings window-position source: spawn a persistent `zcode-window-bounds` process and read its stdout.
 *
 * All design constraints follow one principle: snapping improves appearance but is not required for
 * usability.
 *   - A missing binary, spawn failure, process crash, or malformed output all produce
 *     `latest() === null`; the positioner then fails open and puts the panel at the bottom of the
 *     screen. **No path may throw**, or a cosmetic failure could become "authorization guidance cannot open."
 *   - Stop reporting stale positions immediately when the process exits; otherwise the panel could
 *     remain pinned to the last System Settings location, which is worse than the bottom-of-screen
 *     fallback because users may think the panel is stuck.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Rect } from "./cuaPermissionPanelPositioner.js";

export interface SystemSettingsWindowWatcher {
  start(): void;
  stop(): void;
  /** Most recently parsed bounds for the System Settings main window; null when unavailable. */
  latest(): Rect | null;
}

export interface CreateSystemSettingsWindowWatcherOptions {
  binaryPath: string;
  intervalMs?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: (binaryPath: string, args: string[]) => ChildProcess;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

const DEFAULT_INTERVAL_MS = 150;

interface RawWindow {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  layer?: unknown;
}

function toRect(raw: RawWindow): Rect | null {
  const { x, y, w, h, layer } = raw;
  // Accept only layer 0: Settings also creates layer > 0 auxiliary windows (tooltips, pop-up
  // pickers), and snapping to them would throw the panel into a screen corner.
  if (layer !== 0) return null;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function parseLine(line: string): Rect | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  // Choose the largest layer-0 window, not the first one in z-order.
  //
  // After a drag ends, System Settings shows a modal warning ("…may not be able to record the
  // contents of your screen until it is quit…"). It belongs to the same process, is also layer 0,
  // and is above the main window in z-order. Choosing the first window would snap the panel to the
  // warning's bottom and place it underneath. The main Settings window is always the largest of these windows.
  let best: Rect | null = null;
  let bestArea = 0;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const rect = toRect(entry as RawWindow);
    if (!rect) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

export function createSystemSettingsWindowWatcher(
  options: CreateSystemSettingsWindowWatcherOptions,
): SystemSettingsWindowWatcher {
  const platform = options.platform ?? process.platform;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const spawnProcess =
    options.spawnProcess ?? ((path, args) => spawn(path, args, { stdio: "pipe" }));

  let child: ChildProcess | null = null;
  let current: Rect | null = null;
  // stdout chunks do not align with line boundaries, so assemble lines here; parsing each chunk directly fails intermittently on real machines.
  let buffer = "";

  function reset(): void {
    current = null;
    buffer = "";
  }

  return {
    start(): void {
      if (platform !== "darwin" || child) return;
      try {
        child = spawnProcess(options.binaryPath, [String(intervalMs)]);
      } catch (error) {
        // Binary missing from the package or not executable: fail open; the panel still works, but does not snap.
        options.logger.warn(
          "[cua-permission-panel] window bounds helper unavailable; panel will not anchor",
          error instanceof Error ? error.message : String(error),
        );
        child = null;
        return;
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = buffer.split("\n");
        // The final segment may be an incomplete line; keep it in the buffer for the next chunk.
        buffer = lines.pop() ?? "";
        // Keep only the latest complete line; earlier lines contain stale positions.
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]!;
          if (line.trim().length === 0) continue;
          current = parseLine(line);
          return;
        }
      });

      child.on("error", (error: Error) => {
        options.logger.warn("[cua-permission-panel] window bounds helper error", error.message);
        reset();
        child = null;
      });

      child.on("exit", (code: number | null) => {
        // Do not report stale positions after the process dies; a panel stuck at an old location is more confusing than falling back to the bottom of the screen.
        if (code !== 0 && code !== null) {
          options.logger.warn("[cua-permission-panel] window bounds helper exited", code);
        }
        reset();
        child = null;
      });
    },

    stop(): void {
      if (child) {
        try {
          child.kill();
        } catch {
          // Already exited; ignore.
        }
        child = null;
      }
      reset();
    },

    latest(): Rect | null {
      return current;
    },
  };
}
