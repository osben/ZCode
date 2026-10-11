import { formatLogPrefix } from "@zcode/shared";

export type LogLevel = "debug" | "info" | "warn" | "error";

type DesktopLogLevel = Exclude<LogLevel, "debug">;

type DesktopLogBridgeWindow = Window & {
  zcode?: {
    log?: (level: DesktopLogLevel, args: unknown[]) => void;
  };
};

function isRendererProductionBuild(): boolean {
  const viteProduction =
    ((import.meta as ImportMeta & { env?: { readonly PROD?: boolean } }).env ?? {}).PROD === true;
  // Vitest’s import.meta.env.PROD is fixed during transformation; the NODE_ENV fallback makes the production branch
  // testable, while actual renderer builds still use Vite’s PROD flag.
  return (
    viteProduction || (typeof process !== "undefined" && process.env.NODE_ENV === "production")
  );
}

function isRendererLoggingDisabled(): boolean {
  return (
    (
      globalThis as typeof globalThis & {
        __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean;
      }
    ).__ZCODE_RENDERER_DISABLE_LOGGING__ === true
  );
}

const consoleFns: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

export function isLoggerLevelEnabled(_level: LogLevel): boolean {
  // In production builds, all renderer log levels are disabled; expose a guard so callers can exit before constructing large payloads.
  return !isRendererProductionBuild() && !isRendererLoggingDisabled();
}

function log(level: LogLevel, ...args: unknown[]) {
  // In production builds, renderer logging is a no-op, avoiding console formatting, IPC forwarding, and disk writes that slow the render thread.
  if (!isLoggerLevelEnabled(level)) {
    return;
  }
  consoleFns[level](formatLogPrefix("ui"), ...args);
  // When typechecking the ui package on its own, the window.zcode declaration injected by the desktop renderer is unavailable,
  // and the Electron bridge accepts only info/warn/error; forwarding debug unchanged would mismatch both the types and host protocol.
  // Narrow the bridge shape explicitly here and forward only levels actually supported by the main process.
  if (level !== "debug" && typeof window !== "undefined") {
    // Pure frontend state modules such as tabStore now also emit info logs in Vitest’s Node environment.
    // If this accesses window unconditionally, a test will throw ReferenceError as soon as it logs,
    // creating new test noise while troubleshooting. Check that execution is in a browser before using the desktop bridge.
    (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
  }
}

function lifecycleLog(level: DesktopLogLevel, ...args: unknown[]) {
  // Production builds keep only filtered lifecycle diagnostics by default, so message-stream logging is not re-enabled.
  // Tests and fault injection can still disable all renderer logging with an explicit global switch.
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (isRendererProductionBuild()) {
    if (typeof window !== "undefined") {
      (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
    }
    return;
  }
  log(level, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
  lifecycle: {
    info: (...args: unknown[]) => lifecycleLog("info", ...args),
    warn: (...args: unknown[]) => lifecycleLog("warn", ...args),
    error: (...args: unknown[]) => lifecycleLog("error", ...args),
  },
  /** Log entries prefixed with traceId for end-to-end tracing */
  trace: (traceId: string, level: LogLevel, ...args: unknown[]) => {
    log(level, `[trace:${traceId}]`, ...args);
  },
};

/**
 * The only renderer entry point for process-local in-memory diagnostic logs.
 * It is an exception to the renderer's production logging policy for the "official monitoring pipeline": production builds still write through the desktop bridge (at most one line every 60 s,
 * and only when values change); on Web, it is a no-op when no bridge is available. Business modules must not use it to bypass production gating.
 */
export function logMemoryDiagnostics(line: string): void {
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (typeof window !== "undefined") {
    const bridge = (window as DesktopLogBridgeWindow).zcode?.log;
    if (bridge) {
      bridge("info", [line]);
      return;
    }
  }
  if (!isRendererProductionBuild()) {
    consoleFns.info(formatLogPrefix("ui"), line);
  }
}
