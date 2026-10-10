// Feedback and model connectivity used to maintain separate error-code lists, so Undici connection timeouts were recognized in only some paths.
// Normalize errors consistently along cause/AggregateError chains to avoid callers missing them due to different runtime wrapper depths.
const NETWORK_FAILURE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
]);

const RETRYABLE_CONNECTION_ESTABLISHMENT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
]);

interface NetworkErrorDetails {
  codes: Set<string>;
  messages: string[];
}

export function getNetworkErrorCodes(error: unknown): string[] {
  return [...collectNetworkErrorDetails(error).codes].sort();
}

export function isNetworkFailure(error: unknown): boolean {
  const { codes } = collectNetworkErrorDetails(error);
  return [...codes].some((code) => NETWORK_FAILURE_CODES.has(code));
}

export function isRetryableConnectionEstablishmentError(error: unknown): boolean {
  const { codes, messages } = collectNetworkErrorDetails(error);
  if ([...codes].some((code) => RETRYABLE_CONNECTION_ESTABLISHMENT_CODES.has(code))) {
    return true;
  }
  // ETIMEDOUT can also occur after a POST request body has been sent, so the error code alone is not enough to retry ticket creation.
  // Node connection timeouts explicitly include connection attempts/connect ETIMEDOUT; retry only when that evidence is present.
  if (
    codes.has("ETIMEDOUT") &&
    messages.some((message) => /connection attempts timed out|connect ETIMEDOUT/i.test(message))
  ) {
    return true;
  }
  return (
    codes.has("ECONNRESET") &&
    messages.some((message) => /before secure TLS connection was established/i.test(message))
  );
}

function collectNetworkErrorDetails(error: unknown): NetworkErrorDetails {
  const details: NetworkErrorDetails = { codes: new Set(), messages: [] };
  const seen = new Set<object>();
  const pending: unknown[] = [error];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as {
      cause?: unknown;
      code?: unknown;
      errors?: unknown;
      message?: unknown;
    };
    if (typeof record.code === "string") {
      details.codes.add(record.code);
    }
    if (typeof record.message === "string") {
      details.messages.push(record.message);
    }
    if (record.cause !== undefined) {
      pending.push(record.cause);
    }
    if (Array.isArray(record.errors)) {
      pending.push(...record.errors);
    }
  }

  return details;
}
