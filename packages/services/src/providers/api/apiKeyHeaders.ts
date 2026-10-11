const STRUCTURED_API_KEY_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const HEADER_VISIBLE_ASCII_PREFIX_PATTERN = /^[\x21-\x7e]+/;

export function normalizeApiKeyForHeader(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  const matchedStructuredKey = trimmed.match(STRUCTURED_API_KEY_PATTERN)?.[0];
  if (matchedStructuredKey) {
    return matchedStructuredKey;
  }

  const asciiPrefix = trimmed.match(HEADER_VISIBLE_ASCII_PREFIX_PATTERN)?.[0];
  if (!asciiPrefix) {
    return "";
  }

  // When copying an API key, users may also paste a non-ASCII note into the input.
  // fetch header values must be ByteStrings, so the request path consistently extracts the ASCII key and avoids throwing while constructing Authorization.
  return asciiPrefix.trim();
}
