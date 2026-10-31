const MODEL_AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key"]);
export const MODEL_QUERY_SOURCE_HEADER = "x-zcode-query-source";
/** Session capability tags (docs/design/v2/model/session-features-header.md). */
export const MODEL_SESSION_FEATURES_HEADER = "x-zcode-session-features";
/** Attribution headers that only the calling context may generate: provider static values and
 *  SDK defaults are always stripped, with no fallback when absent. */
const MODEL_CONTEXT_OWNED_HEADER_NAMES = new Set([
  MODEL_QUERY_SOURCE_HEADER,
  MODEL_SESSION_FEATURES_HEADER,
]);

/** Request purpose and session capabilities are owned by the calling context and must not be
 *  inherited from Provider static config or SDK default headers. */
export function withoutContextOwnedModelHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !MODEL_CONTEXT_OWNED_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
}

/** Account authentication is decided by the request-time owner; static defaults and Personal config cannot override fresh credentials. */
export function withoutModelAuthHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !MODEL_AUTH_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
}

/** HTTP header names are case-insensitive; later values replace earlier ones to prevent the SDK from combining differently cased duplicates. */
export function mergeModelRequestHeaders(
  ...sources: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
      headers[name] = value;
    }
  }
  return headers;
}
