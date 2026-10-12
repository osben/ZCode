// Strict canonical parsing of Plugin conversation references.
// Contract:
// - Accept only Markdown link destinations shaped as `plugin://stable-id`; the scheme is case-sensitive (lowercase only).
// - stable-id must be `name@marketplace`; both parts match [A-Za-z0-9][A-Za-z0-9._-]* and total length is at most 256.
// - Reject queries, fragments, credentials, whitespace, control characters, and `%` (no implicit percent-decoding).
// - Identity comes only from the destination; the label is never parsed.

const PLUGIN_REFERENCE_SCHEME = "plugin://";
// Match mentionMarkdown's link syntax: labels support backslash escapes, and destinations support <...> or bare form.
// 修复依据：普通 destination 字符分支排除反斜杠，避免与转义分支重叠并产生灾难性回溯。
const MARKDOWN_LINK_PATTERN =
  /\[(?:\\.|[^\\\]])*\]\((?:<((?:\\.|[^>\\])*?)>|((?:\\.|[^)\s\\])*))\)/g;
const PLUGIN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MAX_PLUGIN_REFERENCES_PER_TURN = 8;
const MAX_PLUGIN_STABLE_ID_LENGTH = 256;

/**
 * Check whether a candidate string is a strictly valid Plugin stable ID (`name@marketplace`).
 * The parser and reminder output both use this check as a fail-closed defense.
 */
export function isValidPluginStableId(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_PLUGIN_STABLE_ID_LENGTH) {
    return false;
  }
  const separatorIndex = candidate.indexOf("@");
  if (separatorIndex <= 0 || separatorIndex !== candidate.lastIndexOf("@")) {
    return false;
  }
  const name = candidate.slice(0, separatorIndex);
  const marketplace = candidate.slice(separatorIndex + 1);
  // The per-segment character set is the complete security boundary: queries, fragments, credentials,
  // whitespace, control characters, and % are outside [A-Za-z0-9._-], so reject them without implicit percent-decoding or permissive matching.
  return PLUGIN_ID_SEGMENT_PATTERN.test(name) && PLUGIN_ID_SEGMENT_PATTERN.test(marketplace);
}

function parsePluginDestination(destination: string): string | null {
  // The scheme is case-sensitive: reject `Plugin://` and `PLUGIN://`.
  if (!destination.startsWith(PLUGIN_REFERENCE_SCHEME)) {
    return null;
  }
  const stableId = destination.slice(PLUGIN_REFERENCE_SCHEME.length);
  if (!isValidPluginStableId(stableId)) {
    return null;
  }
  return stableId;
}

function isPluginSchemeDestination(destination: string): boolean {
  // Count a destination as invalid only when it appears to intend the Plugin scheme;
  // case variants (such as Plugin://) still count as intent but fail parsing, preventing labels from bypassing the metric.
  return /^plugin:\/\//i.test(destination);
}

export interface ExtractPluginReferencesResult {
  /** References deduplicated by stable ID and ordered by first appearance in the body. */
  references: string[];
  /** Number of references dropped after the per-turn limit (fail closed; callers log a debug truncation). */
  truncatedCount: number;
  /** Number of destinations that intend the Plugin scheme but fail parsing (format-level rejection before unknown-ID checks). */
  invalidCount: number;
}

/**
 * Extract Plugin references (stable IDs) from canonical user text.
 * Identity comes only from link destinations; Markdown labels are ignored.
 */
export function extractPluginReferences(input: string): ExtractPluginReferencesResult {
  const references: string[] = [];
  const seen = new Set<string>();
  let truncatedCount = 0;
  let invalidCount = 0;

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of input.matchAll(MARKDOWN_LINK_PATTERN)) {
    const destination = match[1] ?? match[2] ?? "";
    if (!isPluginSchemeDestination(destination)) {
      continue;
    }
    const stableId = parsePluginDestination(destination);
    if (stableId === null) {
      invalidCount++;
      continue;
    }
    if (seen.has(stableId)) {
      continue;
    }
    if (references.length >= MAX_PLUGIN_REFERENCES_PER_TURN) {
      truncatedCount++;
      continue;
    }
    seen.add(stableId);
    references.push(stableId);
  }

  return { references, truncatedCount, invalidCount };
}
