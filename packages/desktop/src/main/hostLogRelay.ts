type HostStructuredLogLevel = "info" | "warn" | "error";

interface HostStructuredLog {
  level: HostStructuredLogLevel;
  source: string;
  message: string;
}

interface HostLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface RawStreamLog {
  kind: "stdout" | "stderr";
  message: string;
}

interface EmitStructuredLogEntry extends HostStructuredLog {
  timestamp: string;
}

/**
 * The host now reports logs through both stdout/stderr and postMessage.
 * If main writes both streams to disk immediately, each log appears twice.
 * Prefer structured postMessage logs; replay the early stdout/stderr buffer as a fallback only
 * when the host has not emitted structured logs before exiting.
 */
export function createHostLogRelay(
  label: string,
  logger: HostLogger,
  emitStructuredLogToRenderer?: (entry: EmitStructuredLogEntry) => void,
) {
  let hasStructuredLog = false;
  const rawLogs: RawStreamLog[] = [];

  function emitRawLog(rawLog: RawStreamLog): void {
    if (rawLog.kind === "stderr") {
      if (isNodeWarning(rawLog.message)) {
        logger.warn(`[host-stderr] (${label}):`, formatNodeWarning(rawLog.message));
        return;
      }

      logger.error(`[host-stderr] (${label}):`, rawLog.message);
      return;
    }

    logger.info(`[host-stdout] (${label}):`, rawLog.message);
  }

  function emitStructuredLog(entry: EmitStructuredLogEntry): void {
    const line = `[host-log] (${label}) [${entry.source}] ${entry.message}`;
    if (entry.level === "error") {
      logger.error(line);
      return;
    }

    if (entry.level === "warn") {
      logger.warn(line);
      return;
    }

    logger.info(line);
  }

  return {
    onStdout(message: string): void {
      if (hasStructuredLog) {
        return;
      }

      rawLogs.push({ kind: "stdout", message });
    },

    onStderr(message: string): void {
      if (hasStructuredLog) {
        return;
      }

      rawLogs.push({ kind: "stderr", message });
    },

    onStructuredLog(entry: HostStructuredLog): void {
      hasStructuredLog = true;
      rawLogs.length = 0;
      const structuredEntry = {
        ...entry,
        timestamp: new Date().toLocaleTimeString(undefined, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      } satisfies EmitStructuredLogEntry;
      emitStructuredLog(structuredEntry);
      emitStructuredLogToRenderer?.(structuredEntry);
    },

    flushRawLogs(): void {
      if (hasStructuredLog) {
        rawLogs.length = 0;
        return;
      }

      for (const rawLog of rawLogs) {
        emitRawLog(rawLog);
      }
      rawLogs.length = 0;
    },
  };
}

function isNodeWarning(message: string): boolean {
  // Early Node warnings from an Electron utility process appear only on stderr.
  // These warnings are not connection failures; keep their warn severity during fallback replay
  // so remote-connection logs are not mislabeled as errors.
  return /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|Warning):/u.test(
    message.trimStart(),
  );
}

function formatNodeWarning(message: string): string {
  // The second line of a Node warning is usually just a --trace-warnings hint and looks like error
  // details on the connection page. Keep only the core first warning line in remote-connection logs;
  // enable trace through development startup arguments for full diagnostics.
  return message.trimStart().split(/\r?\n/u)[0]?.trimEnd() ?? message.trim();
}
