import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { formatTimestamp } from "@zcode/shared";
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
  mkdirSync(logDir, { recursive: true });
  const filePath = join(logDir, `${formatDate(now)}.log`);

  // Keep console output for development debugging; include timestamps and PID to match the file format.
  safeConsoleWrite(level, `[${ts}] [pid:${pid}] [${source}]`, ...args);

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
