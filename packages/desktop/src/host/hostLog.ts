const NODE_WARNING_LOG_PATTERN =
  /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|Warning):/u;

export function shouldReportHostConsoleError(args: unknown[]): boolean {
  const message = args
    .map((arg) => stringifyHostLogArg(arg))
    .join(" ")
    .trimStart();
  return !NODE_WARNING_LOG_PATTERN.test(message);
}

export function stringifyHostLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }

  if (arg instanceof Error) {
    try {
      return JSON.stringify(serializeErrorForHostLog(arg));
    } catch {
      return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
    }
  }

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function serializeErrorForHostLog(error: Error): {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
} {
  const serialized: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  } = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) {
    serialized.stack = error.stack;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) {
    // Error becomes {} when passed to JSON.stringify, leaving remote handshake failures as empty objects.
    // cause may also be an Error; recursively convert it to a plain object so the Host log relay preserves the actual error chain.
    serialized.cause = cause instanceof Error ? serializeErrorForHostLog(cause) : cause;
  }
  return serialized;
}
