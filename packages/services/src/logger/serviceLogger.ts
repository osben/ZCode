import { formatLogPrefix, type TraceId } from "@zcode/shared";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface ServiceLogSink {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ServiceLogger {
  debug: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  info: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  error: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export function createServiceLogger(
  scope: string,
  options?: {
    pid?: number;
    sink?: ServiceLogSink;
    // Print debug logs by default only in local development; tests and packaged builds use production mode to avoid persisting high-volume logs.
    isDebugEnabled?: boolean | (() => boolean);
  },
): ServiceLogger {
  const pid = options?.pid ?? process.pid;
  const sink = options?.sink ?? console;
  const debugOption = options?.isDebugEnabled;
  const resolveDebugEnabled: () => boolean =
    typeof debugOption === "function"
      ? debugOption
      : typeof debugOption === "boolean"
        ? () => debugOption
        : () => isEffectiveDevelopmentNodeEnv();

  function write(
    level: "debug" | "info" | "warn" | "error",
    traceId: TraceId | undefined,
    ...args: unknown[]
  ): void {
    // Service logs were often reused with the ZCode Agent-named logger, causing new ZCode paths to keep depending on the ZCode Agent directory.
    // Put generic leveled logging in a separate module so removing the ZCode Agent runtime later will not affect unrelated services.
    if (level === "debug" && !resolveDebugEnabled()) {
      return;
    }
    const source = traceId ? `${scope}][trace:${traceId}` : scope;
    const consoleFn =
      level === "error"
        ? sink.error
        : level === "warn"
          ? sink.warn
          : level === "debug"
            ? (sink.debug ?? sink.log)
            : sink.log;
    consoleFn(formatLogPrefix(source, pid), ...args);
  }

  return {
    debug: (traceId, ...args) => write("debug", traceId, ...args),
    info: (traceId, ...args) => write("info", traceId, ...args),
    warn: (traceId, ...args) => write("warn", traceId, ...args),
    error: (traceId, ...args) => write("error", traceId, ...args),
  };
}
