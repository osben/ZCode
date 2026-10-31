import { mkdirSync, appendFileSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLocalTtftLogQueue, formatTimestamp } from "@zcode/shared";
import { cleanupExpiredLogFiles, LOG_RETENTION_DAYS } from "./logRetention.js";
import { getAppConfigDir, maybeThrowInjectedFsFault } from "@zcode/services/node";

function getLogDir() {
  const e2eLogDir =
    process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;
  if (e2eLogDir) {
    return e2eLogDir;
  }
  return join(getAppConfigDir(), "logs");
}

// Ensure the log directory exists at startup.
const LOG_DIR = getLogDir();
mkdirSync(LOG_DIR, { recursive: true });

const logRetentionResult = cleanupExpiredLogFiles(LOG_DIR);
if (logRetentionResult.failedFiles.length > 0) {
  safeConsoleWrite(
    "warn",
    `[log-retention] failed to delete expired logs from ${LOG_DIR}:`,
    logRetentionResult.failedFiles,
    `retentionDays=${LOG_RETENTION_DAYS}`,
  );
}

type LogLevel = "debug" | "info" | "warn" | "error";

let reportedTtftDrops = 0;
const localTtftLogs = createLocalTtftLogQueue(async (entries, dropped) => {
  const files = new Map<string, string>();
  for (const entry of entries) files.set(entry.path, (files.get(entry.path) ?? "") + entry.line);
  for (const [path, contents] of files) {
    await mkdir(dirname(path), { recursive: true });
    maybeThrowInjectedFsFault({ operation: "appendFile", path });
    const loss =
      dropped > reportedTtftDrops
        ? `[ttft] ${JSON.stringify({ event: "ttft.log.dropped", count: dropped })}\n`
        : "";
    await appendFile(path, loss + contents, "utf8");
    reportedTtftDrops = dropped;
  }
});
export async function flushLocalTtftLogs(): Promise<void> {
  await localTtftLogs.flush();
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function ignoreBrokenPipeStreamError(error: Error): void {
  // WDIO / the dev runner may close stdout/stderr pipes before the main process finishes flushing logs.
  // Stream errors are asynchronous, so try/catch around console.log may not catch them; handle EPIPE here.
  if (!isBrokenPipeError(error)) {
    throw error;
  }
}

process.stdout.on("error", ignoreBrokenPipeStreamError);
process.stderr.on("error", ignoreBrokenPipeStreamError);

function safeConsoleWrite(level: LogLevel, ...args: unknown[]): void {
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    consoleFn(...args);
  } catch (error) {
    // After the dev script or parent terminal exits, Electron main's stdout/stderr pipes may be closed.
    // console.* can then throw EPIPE; logging must not terminate the main process, and file logging should continue.
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function write(level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  const filePath = join(logDir, `${formatDate(now)}.log`);
  // TTFT goes through renderer IPC and the host relay; branch off only the dedicated marker so observability sync writes do not slow the measured path.
  if (message.includes("[ttft] ")) {
    localTtftLogs.enqueue({ path: filePath, line });
    return;
  }
  mkdirSync(logDir, { recursive: true });

  // Keep console output for development debugging; include timestamps and PID to match the file format.
  safeConsoleWrite(level, `[${ts}] [pid:${pid}] [${source}]`, ...args);

  try {
    maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
    appendFileSync(filePath, line);
  } catch {
    // A log-write failure must not affect application operation.
  }
}

function writeDedicated(filePrefix: string, level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });
  // Bugfix: mixing remote-control relay traces into the main log made the directory fill up
  // quickly and hard to inspect by hand. Route high-frequency traces into a logs subdirectory so
  // they do not interfere with browsing or locating exported main logs.
  const dedicatedDir = join(logDir, "web-remote-control");
  mkdirSync(dedicatedDir, { recursive: true });
  const filePath = join(dedicatedDir, `${filePrefix}-${formatDate(now)}.log`);

  try {
    maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
    appendFileSync(filePath, line);
  } catch {
    // A log-write failure must not affect application operation.
  }
}

/**
 * Main-process logs are written to ~/.zcode/v2/logs/YYYY-MM-DD.log by default; E2E tests use a worker-specific directory.
 * Console output is also kept for development debugging.
 */
export const logger = {
  // Record high-frequency browser/CDP protocol details only in local development to keep production log volume below command-stream volume.
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      write("debug", "main", ...args);
    }
  },
  info: (...args: unknown[]) => write("info", "main", ...args),
  warn: (...args: unknown[]) => write("warn", "main", ...args),
  error: (...args: unknown[]) => write("error", "main", ...args),

  /** Called to write renderer logs, received over IPC, to the same file. */
  fromRenderer: (level: LogLevel, args: unknown[]) => write(level, "renderer", ...args),
};

/**
 * Dedicated log for Web remote-control relay message traces.
 * Used only for high-frequency link debugging; written to separate files to avoid drowning the main log.
 */
export const webRemoteControlRelayLogger = {
  info: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "info", "web-remote-control-relay", ...args),
  warn: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "warn", "web-remote-control-relay", ...args),
  error: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "error", "web-remote-control-relay", ...args),
};
