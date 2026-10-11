function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return undefined;
}

function getErrorCandidate(error: unknown): unknown {
  if (!isRecord(error) || !("error" in error) || !isRecord(error.error)) {
    return error;
  }

  if ("message" in error.error || "code" in error.error) {
    return error.error;
  }

  return error;
}

export interface NormalizedUnknownError {
  message: string;
  code?: string;
}

export const ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_FILE_LOCK_TIMEOUT" as const;

export function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Some protocol error objects contain circular references.
    // Swallow JSON serialization failures here to avoid triggering a second error while displaying the original error.
  }

  return String(value);
}

export function normalizeUnknownError(error: unknown): NormalizedUnknownError {
  const candidate = getErrorCandidate(error);
  if (candidate instanceof Error) {
    const errorWithCode = candidate as Error & { code?: unknown };
    return {
      // Some runtime Error.message values may be empty strings.
      // Fall back in the order message -> name -> String so the frontend always gets displayable text.
      message: candidate.message || candidate.name || String(candidate),
      code: normalizeErrorCode(errorWithCode.code),
    };
  }

  if (isRecord(candidate)) {
    const code = "code" in candidate ? normalizeErrorCode(candidate.code) : undefined;
    const message =
      "message" in candidate
        ? stringifyUnknownValue(candidate.message)
        : stringifyUnknownValue(candidate);

    return {
      message:
        message !== "undefined" && message.length > 0 ? message : stringifyUnknownValue(candidate),
      code,
    };
  }

  return {
    message: stringifyUnknownValue(candidate),
  };
}

export function isZCodeFileLockTimeoutError(error: unknown): boolean {
  return normalizeUnknownError(error).code === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
}

/**
 * Error patterns for workspace ZCode Agent warm-up failures that must not be retried automatically.
 *
 * These errors represent deterministic configuration/installation/auth problems; retrying will not help.
 * Also used for MCP-fallback downgrade decisions: when one of these patterns matches, skip the MCP
 * fallback because the error is unrelated to MCP.
 */
export const NON_RETRYABLE_WORKSPACE_PREPARE_ERROR_PATTERNS = [
  "binary 未找到",
  "未正确安装",
  "binary not found",
  "not installed",
  "initialize 前进程已退出",
  "initialize 超时",
  "进程启动失败",
  "optional dependency was not installed",
  "Cannot find package '@openai/codex-",
  "Missing optional dependency @openai/codex-",
  "Missing Codex runtime files",
  "Gemini API key is missing or not configured",
  "Please fix the configuration file(s)",
  "Expected property name or '}' in JSON",
  "已暂停自动重试",
] as const;

/**
 * Additional error patterns that must not trigger the MCP-fallback downgrade.
 *
 * A session/new timeout means the agent itself is stuck starting up or logging in; it is unrelated to
 * MCP, so downgrading does not help.
 */
export const NON_MCP_FALLBACK_EXTRA_ERROR_PATTERNS = ["session/new 超时"] as const;

const OPENCODE_RUNTIME_CRASH_ERROR_PATTERNS = [
  "opencode runtime 崩溃",
  "opencode runtime crashed",
  "bun has crashed",
  "segmentation fault",
  "panic(main thread)",
  "code=3221226505",
] as const;

/**
 * Determine whether an error message represents a deterministic failure that should not retry
 * workspace ZCode Agent warm-up automatically.
 */
export function isNonRetryableWorkspacePrepareError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase();
  return NON_RETRYABLE_WORKSPACE_PREPARE_ERROR_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern.toLowerCase()),
  );
}

/**
 * Determine whether OpenCode hit a Bun/runtime crash.
 *
 * Unlike missing configuration, rebuilding the process shortly afterwards may recover, but repeated
 * occurrences should stop automatic retries so the UI does not just show a generic "connection closed"
 * and drag the user through a pointless 5/5 wait.
 */
export function isOpenCodeRuntimeCrashError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase();
  return OPENCODE_RUNTIME_CRASH_ERROR_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern.toLowerCase()),
  );
}
