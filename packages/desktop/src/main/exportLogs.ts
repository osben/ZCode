/* eslint-disable max-lines -- Keep log collection, redaction, and packaging together for consistency and easier troubleshooting. */
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

import {
  CLI_MEMORY_DIAGNOSTICS_DIR_NAME,
  CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN,
} from "@zcode/shared";
import {
  createFeedbackDiagnosticArchive,
  getAppConfigDir,
  getExportLogDir as getDefaultExportLogDir,
  getExportLogStageDir as getDefaultExportLogStageDir,
  getFeedbackLogArchiveDir as getDefaultFeedbackLogArchiveDir,
} from "@zcode/services/node";
import { createAboutSnapshot, formatAboutDetail, readBuildMetadata } from "./about.js";
import { logger } from "./logger.js";

function getZCodeDataDir() {
  return getAppConfigDir();
}

function getZCodeCliDir() {
  return join(homedir(), ".zcode", "cli");
}

function getZCodeCliLogDir() {
  return join(getZCodeCliDir(), "log");
}

/**
 * Computer Use Helper runtime directory. On macOS, LaunchServices starts the Helper and the system discards stderr,
 * so it tees lifecycle and background-input diagnostics to `<socket>.exit.log` (see zcode-cua helperExitLogPathFor).
 * The directory also contains `.tokens` broker credentials, so collection must use a filename allowlist.
 */
function getCuaHelperRunDir() {
  return join(homedir(), ".zcode", "computer-use", "run");
}

function isCuaHelperDiagnosticFileName(fileName: string): boolean {
  return fileName.endsWith(".exit.log");
}

/** Agent CLI heap-profile records written by the protocol recorder (memory-<ms>-<instanceId>.jsonl). */
function getZCodeCliMemoryDiagnosticsDir(): string {
  return join(getZCodeCliDir(), CLI_MEMORY_DIAGNOSTICS_DIR_NAME);
}

function isCliMemoryDiagnosticFileName(fileName: string): boolean {
  return CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN.test(fileName);
}

interface LogArchiveFileEntry {
  absolutePath: string;
  archivePath: string;
}

interface LogArchiveArtifacts {
  files: LogArchiveFileEntry[];
  aboutContent: string;
}

interface CreateLogArchiveArtifactsOptions {
  now?: () => Date;
  lookbackDays?: number;
}

interface LogArchiveSkippedFileEntry {
  absolutePath: string;
  archivePath: string;
  error: string;
}

interface ExportLogsDependencies {
  now?: () => Date;
  getZCodeDataDir?: () => string;
  getExportLogStageDir?: () => string;
  getExportLogDir?: () => string;
  createLogArchiveArtifacts?: (
    sourceDir: string,
    options?: CreateLogArchiveArtifactsOptions,
  ) => Promise<LogArchiveArtifacts>;
  writeLogArchiveZip?: (
    outputPath: string,
    artifacts: LogArchiveArtifacts,
    options?: WriteLogArchiveZipOptions,
  ) => Promise<void>;
  writeLogArchiveDirectory?: (outputPath: string, artifacts: LogArchiveArtifacts) => Promise<void>;
  showItemInFolder?: (path: string) => Promise<void> | void;
}

interface WriteLogArchiveZipOptions {
  stageRootDir?: string;
}

interface CreateFeedbackLogArchiveFromExportLogsOptions {
  now?: () => Date;
  outputRootDir?: string;
  stageRootDir?: string;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

function formatTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function normalizeArchivePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegExp(path: string): string {
  return path.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeArchivePath(pattern);
  return new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
}

/**
 * Glob patterns to exclude from the exported log archive.
 * Each pattern is relative to the source directory being archived.
 */
const ZIP_EXCLUDE_PATTERNS: string[] = [];

const ZIP_EXCLUDE_REGEXES = ZIP_EXCLUDE_PATTERNS.map(globPatternToRegExp);
const RETIRED_ACP_RUNTIME_ARCHIVE_PATHS = [
  "acp-auth",
  "acp-config",
  "acp-stream-diagnostics",
  "acp-traffic-proxy",
] as const;
const HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS = ["dev"] as const;
const DOCSHOT_ARCHIVE_PATH_PREFIXES = ["docshot-backup-"] as const;
const DOCSHOT_ARCHIVE_PATHS = ["docshot-assets"] as const;
const NON_LOG_STATE_ARCHIVE_PATHS = [
  "agent-config",
  "certs",
  "repo-snapshots",
  "repo-wiki",
  "sessions",
  "session-bindings",
  "checkpoints",
] as const;
const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set(["credentials.json", ".credentials.json"]);
const EXCLUDED_ARCHIVE_DIRECTORY_NAMES = new Set(["debug"]);
const DEFAULT_LOG_EXPORT_LOOKBACK_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const REDACTED_PLACEHOLDER = "***REDACTED***";
// Sensitive key-name "families": treat any key containing these substrings as sensitive (fallback wildcard),
// covering custom names such as db_password, my_secret, and x-conn-string without listing each one.
// Note: token/auth are broad substrings, so the allowlist below excludes false positives such as input_tokens and author.
const SENSITIVE_KEY_SUBSTRING_PATTERN = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "credential",
  "api(?:_|-)?key",
  "access(?:_|-)?key",
  "private(?:_|-)?key",
  "auth",
  "cookie",
  "dsn",
  "conn(?:ection)?(?:_|-)?str(?:ing)?",
  "database(?:_|-)?url",
  "db(?:_|-)?url",
].join("|");
const SENSITIVE_KEY_NAME_REGEX = new RegExp(`(?:${SENSITIVE_KEY_SUBSTRING_PATTERN})`, "i");
// Allowlist: common key names that contain a sensitive substring but are not secrets, so the context needed for troubleshooting is not stripped.
// Not every "*_tokens" may be allowlisted, or access_tokens/session_tokens would be exported verbatim;
// max_tokens/budget_tokens are model output and thinking budgets, not credentials, and are kept to judge whether a provider request hit a limit;
// so only explicit LLM token count/budget fields are allowed here, plus ordinary words containing "auth" such as author/authority.
// Numbers under sensitive keys are also redacted, so counting keys must be listed one by one: the prefix is made only of counting words (no bare access/session/
// refresh/id/read/write), covering each provider's usage fields (cache_read_input_tokens,
// ephemeral_5m_input_tokens, *_tokens_details, max_completion_tokens, *TokenCount) and ZCode's internal
// camelCase counters (cacheReadTokens, maxOutputTokens). buildSnapshot is snapshot timing and falsely matched the "dsn" substring.
// The "_" below is a placeholder for the key-name separator; after the full regex is assembled it is uniformly replaced with "optional _ or -" (to support camelCase).
const TOKEN_COUNT_KEY_PREFIX_PATTERN = [
  "prompt",
  "completion",
  "total",
  "input",
  "output",
  "reasoning",
  "max",
  "budget",
  "audio",
  "candidates",
  "thoughts",
  "accepted_prediction",
  "rejected_prediction",
  "tool_use_prompt",
  "max_output",
  "max_completion",
  "prompt_cache_(?:hit|miss)",
  "(?:un)?cached(?:_(?:read|write|content))?(?:_input)?",
  "cache_(?:read|write|creation)(?:_input)?",
  "ephemeral_\\d+[mh]_input",
].join("|");
const NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX = new RegExp(
  [
    "^(?:public_key|keywords?|tokenizer|token_count|build_snapshot|author(?:s|ity|ed)?",
    `|(?:total_)?(?:${TOKEN_COUNT_KEY_PREFIX_PATTERN})_(?:tokens(?:_details)?|token_count))$`,
  ]
    .join("")
    .replaceAll("_", "(?:_|-)?"),
  "i",
);

function isSensitiveKeyName(keyName: string): boolean {
  if (NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX.test(keyName)) {
    return false;
  }
  return SENSITIVE_KEY_NAME_REGEX.test(keyName);
}

// The regexes below first loosely capture "key name + value"; isSensitiveKeyName then decides whether to redact,
// so the key-name blocklist is no longer a hardcoded list but "sensitive families + wildcards + allowlist exceptions".
// The third branch captures only the opening bracket of an object/array; redactJsonStyleValues replaces the whole value by bracket matching (see that function).
const JSON_STYLE_SENSITIVE_VALUE_REGEX =
  /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[[{]|[^,\r\n}\]]+)/g;
const ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([^\r\n#]+)/g;
const HEADER_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9-]+)([ \t]*:[ \t]*)([^\r\n]+)/g;
// The Bearer, URL query and connection-string rules match staging: quotes and backslashes inside values are always treated as content.
// JSONL lines are already redacted structurally; this handles only decoded strings and text lines that fail to parse. Stopping at quotes to protect embedded JSON in text
// would export passwords such as `p"a"s` and `ex'ample` whole or partly verbatim (reproduced twice in review).
// The cost is that embedded JSON in a text line may be over-replaced (for example swallowing up to the next field's @); only context is lost, nothing leaks.
const BEARER_TOKEN_REGEX = /(Bearer\s+)([^\s"']+)/g;
const QUERY_TOKEN_REGEX =
  /([?&](?:key|api(?:_|-)?key|access(?:_|-)?token|refresh(?:_|-)?token|token|password|passwd|pwd|secret|client(?:_|-)?secret|auth(?:_|-)?token|session(?:_|-)?token)=)([^&#\s]+)/gi;
// Redact by value shape: the credential portion of a scheme://user:pass@host connection string, covering postgres/mysql/
// mongodb/redis/amqp connection details regardless of key name. Keep scheme and host for troubleshooting.
// Allow an empty username for redis://:password@host. Match the password greedily through the last @ (host cannot contain @),
// so passwords with a literal @ (such as P@ssw0rd) are fully redacted without leaving fragments.
const CONNECTION_STRING_CREDENTIALS_REGEX =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]*):([^/\s]+)@(?=[^@/\s])/gi;
// Recursion depth limit for structured redaction. Real logs are only a few dozen levels deep; lines over the limit are replaced whole with a placeholder line so a stack overflow does not abort the export.
const MAX_JSON_REDACTION_DEPTH = 256;
const JSON_DEPTH_EXCEEDED = Symbol("json-redaction-depth-exceeded");
const JSON_DEPTH_EXCEEDED_LINE = JSON.stringify({
  exportRedaction: `line replaced: JSON nested deeper than ${MAX_JSON_REDACTION_DEPTH} levels`,
});
const TEXT_DETECTION_SAMPLE_BYTES = 64 * 1024;
const EMPTY_BOM = Buffer.alloc(0);

type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

interface TextFileEncodingInfo {
  encoding: SupportedTextEncoding;
  bomLength: number;
  bomBytes: Buffer;
}

interface TextDecodingScore {
  preferredCharRatio: number;
  invalidCharRatio: number;
}

function redactValue(rawValue: string, quoteBareValue = false): string {
  const leadingSpaces = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingSpaces = rawValue.match(/\s*$/)?.[0] ?? "";
  const core = rawValue.trim();
  // Bare values (numbers, booleans, null) under JSON keys (double-quoted) become quoted placeholders, so the line stays valid JSON.
  const quote =
    core.startsWith('"') && core.endsWith('"')
      ? '"'
      : core.startsWith("'") && core.endsWith("'")
        ? "'"
        : quoteBareValue
          ? '"'
          : "";
  const redacted = quote ? `${quote}${REDACTED_PLACEHOLDER}${quote}` : REDACTED_PLACEHOLDER;
  return `${leadingSpaces}${redacted}${trailingSpaces}`;
}

function redactHeaderValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+.+$/i, `Bearer ${REDACTED_PLACEHOLDER}`);
  }
  return REDACTED_PLACEHOLDER;
}

function redactConnectionStringCredentials(rawContent: string): string {
  // postgres://admin:secret@host → postgres://***REDACTED***:***REDACTED***@host
  return rawContent.replace(
    CONNECTION_STRING_CREDENTIALS_REGEX,
    (_match, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  );
}

/** From the opening bracket, find the end position (after the closing bracket) by string-aware bracket matching; returns -1 when no match is found on the same line. */
function findBracketedValueEnd(content: string, start: number): number {
  let depth = 0;
  let stringQuote = "";
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\n" || char === "\r") return -1;
    if (stringQuote) {
      if (char === "\\") index += 1;
      else if (char === stringQuote) stringQuote = "";
      continue;
    }
    if (char === '"' || char === "'") stringQuote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Sensitive values in the form `"key": value` in text. Object/array values cannot look only at the first field: when the inner key name is not sensitive
 * (`{"token":{"value":"…"}}`), the credential would be exported verbatim, so the whole value is replaced by a quoted placeholder via bracket matching;
 * if it does not match on the same line (truncated JSON), replace through the end of the line. Only a line that ends with an opening bracket and has nothing after it is the start of multi-line formatted JSON
 * (config.json); it is left as is, and subsequent lines are still redacted line by line by key name, so the file structure is not broken.
 */
function redactJsonStyleValues(content: string): string {
  const pattern = JSON_STYLE_SENSITIVE_VALUE_REGEX;
  pattern.lastIndex = 0;
  let output = "";
  let cursor = 0;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    // All four capture groups are required in the regex; the defaults exist only to satisfy noUncheckedIndexedAccess.
    const [whole, quote = '"', keyName = "", , rawValue = ""] = match;
    if (!isSensitiveKeyName(keyName)) continue;
    const valueStart = match.index + whole.length - rawValue.length;
    let valueEnd = valueStart + rawValue.length;
    let replacement: string;
    if (rawValue === "{" || rawValue === "[") {
      const bracketEnd = findBracketedValueEnd(content, valueStart);
      if (bracketEnd === -1) {
        const lineBreak = content.slice(valueStart).search(/[\r\n]/);
        const lineEnd = lineBreak === -1 ? content.length : valueStart + lineBreak;
        if (content.slice(valueStart + 1, lineEnd).trim() === "") continue;
        valueEnd = lineEnd;
      } else {
        valueEnd = bracketEnd;
      }
      replacement = `${quote}${REDACTED_PLACEHOLDER}${quote}`;
    } else {
      replacement = redactValue(rawValue, quote === '"');
    }
    output += content.slice(cursor, valueStart) + replacement;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  pattern.lastIndex = 0;
  return output + content.slice(cursor);
}

function sanitizeSensitiveLogContent(rawContent: string): string {
  // Log export cannot copy files verbatim: that would carry token/apiKey values from user config and protocol logs along with them.
  // Production troubleshooting needs the file structure and context kept, but must not leak the key values themselves;
  // common sensitive values are redacted uniformly at export time, while fields and log lines are kept intact so problems can still be traced.
  // Key names are no longer a hardcoded blocklist but "sensitive key-name families + substring wildcards + allowlist exceptions" (isSensitiveKeyName),
  // plus value-shape connection-string redaction, to cover sensitive information with custom naming such as database connection strings.
  return redactJsonStyleValues(redactConnectionStringCredentials(rawContent))
    .replace(
      ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${prefix}${keyName}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      HEADER_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, headerName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(headerName)
          ? `${prefix}${headerName}${separator}${redactHeaderValue(rawValue)}`
          : match,
    )
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(QUERY_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`);
}

interface JsonRedactionState {
  changed: boolean;
}

type JsonRedactionResult =
  | { kind: "invalid" }
  | { kind: "unchanged" }
  | { kind: "changed"; text: string };

// TS 6's lib does not yet declare JSON.rawJSON / JSON.isRawJSON; Electron 44 (V8 15) supports them.
const RAW_JSON = JSON as unknown as {
  rawJSON?: (text: string) => unknown;
  isRawJSON?: (value: unknown) => boolean;
};

function isRawJsonNumber(value: unknown): boolean {
  return RAW_JSON.isRawJSON?.(value) === true;
}

/**
 * When a line is rewritten, numbers are written back as their original literals: integers above 2^53 (request ids, nanosecond timestamps) and forms like `1.50`
 * would be changed by a round trip through Number. Only numbers that would change on a round trip are wrapped; the rest remain plain numbers.
 */
function parseJsonPreservingNumbers(text: string): unknown {
  const rawJSON = RAW_JSON.rawJSON;
  if (!rawJSON) return JSON.parse(text) as unknown;
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined && String(value) !== context.source
      ? rawJSON(context.source)
      : value,
  ) as unknown;
}

/**
 * Parse and redact a JSON text. First use plain JSON.parse to decide whether it needs changing; only when it does is it re-parsed with original numeric literals
 * and written back, so unmatched lines pay no reviver cost and are never re-serialized.
 */
function redactJsonText(text: string, depth: number): JsonRedactionResult {
  const parsed = parseJsonLine(text);
  if (parsed === undefined) return { kind: "invalid" };
  const probe: JsonRedactionState = { changed: false };
  redactJsonValue(parsed.value, false, probe, depth);
  if (!probe.changed) return { kind: "unchanged" };
  const state: JsonRedactionState = { changed: false };
  const redacted = redactJsonValue(parseJsonPreservingNumbers(text), false, state, depth);
  return { kind: "changed", text: JSON.stringify(redacted) };
}

function redactJsonStringValue(value: string, state: JsonRedactionState, depth: number): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // JSON embedded in strings (request bodies, tool arguments) is recursed structurally; otherwise an inner api_key would be missed as plain text.
    // Nested JSON shares the depth budget with the outer level, so layers nested inside strings cannot bypass the limit.
    const nested = redactJsonText(trimmed, depth + 1);
    if (nested.kind === "unchanged") return value;
    if (nested.kind === "changed") {
      state.changed = true;
      return nested.text;
    }
  }
  const sanitized = sanitizeSensitiveLogContent(value);
  if (sanitized !== value) state.changed = true;
  return sanitized;
}

/**
 * Object keys can also be credentials: connection strings, URLs with tokens, and `Bearer …` used as keys are redacted by value shape and then written back.
 * Two keys may become identical after redaction, so a sequence number prevents a later write from overwriting an earlier one.
 *
 * `nextSuffix` records, per object, which sequence number to try next for each redacted result: when keys under a sensitive parent field all redact to the same placeholder,
 * retrying from ` (2)` for every key would be O(n²), and a line with thousands of keys would block the main process for a long time. Every candidate tried is already taken,
 * and occupancy only grows (the result object only gains keys and the source object is unchanged), so continuing from the last attempt gives exactly the same result as retrying from the start each time.
 */
function redactJsonObjectKey(
  key: string,
  source: object,
  result: Record<string, unknown>,
  nextSuffix: Map<string, number>,
  state: JsonRedactionState,
  sensitive: boolean,
): string {
  let sanitized: string;
  if (sensitive) {
    // Keys under a sensitive parent field can themselves be credentials (maps such as `{"token":{"tok_…":{…}}}` keyed by token);
    // they cannot be expected to carry recognizable shapes such as connection strings, URLs or Bearer: like values, they are replaced whole by a placeholder, with a sequence number for duplicates.
    sanitized = REDACTED_PLACEHOLDER;
  } else {
    // Most keys are identifiers: the text rules all require one of `://`, `=`, `:`, a space, `?`, `&` or a quote, so a pure identifier
    // can never match; skip it so that every key does not run all the regexes (in a 100k-line local log this step was most of the added cost).
    if (!/[^\w.$-]/.test(key)) return key;
    sanitized = sanitizeSensitiveLogContent(key);
    if (sanitized === key) return key;
  }
  state.changed = true;
  // Sequence 1 means the unsuffixed result as-is.
  let index = nextSuffix.get(sanitized) ?? 1;
  let candidate = index === 1 ? sanitized : `${sanitized} (${index})`;
  while (Object.hasOwn(result, candidate) || Object.hasOwn(source, candidate)) {
    index += 1;
    candidate = `${sanitized} (${index})`;
  }
  nextSuffix.set(sanitized, index + 1);
  return candidate;
}

function redactJsonValue(
  value: unknown,
  sensitive: boolean,
  state: JsonRedactionState,
  depth = 0,
): unknown {
  if (depth > MAX_JSON_REDACTION_DEPTH) throw JSON_DEPTH_EXCEEDED;
  if (typeof value === "string") {
    if (sensitive) {
      state.changed = true;
      return REDACTED_PLACEHOLDER;
    }
    return redactJsonStringValue(value, state, depth);
  }
  const isNumber = typeof value === "number" || isRawJsonNumber(value);
  if (isNumber && sensitive) {
    // A number may itself be the credential (a numeric-only password or PIN): under a sensitive key it becomes a string placeholder, and the line stays valid JSON.
    // Numbers under non-sensitive keys (token counts, durations) are kept as-is; counting keys are spared false positives by the allowlist above.
    state.changed = true;
    return REDACTED_PLACEHOLDER;
  }
  if (isNumber) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, sensitive, state, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    // Rebuild with a prototype-less object: writing `__proto__` onto a plain {} triggers the prototype setter, and that key would vanish from the export.
    const result = Object.create(null) as Record<string, unknown>;
    const nextSuffix = new Map<string, number>();
    for (const [key, item] of Object.entries(value)) {
      // Key-name sensitivity is judged on the original key; when the parent field is already sensitive, the key itself is treated as sensitive.
      const outputKey = redactJsonObjectKey(key, value, result, nextSuffix, state, sensitive);
      result[outputKey] = redactJsonValue(
        item,
        sensitive || isSensitiveKeyName(key),
        state,
        depth + 1,
      );
    }
    return result;
  }
  // Booleans and null have only the values true/false/null and cannot carry a credential, so they are kept verbatim even under sensitive keys (auth switches,
  // token: null meaning not configured), so troubleshooting can show whether something is configured.
  return value;
}

function parseJsonLine(line: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(line) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * When a whole line is JSON (model-io / CLI logs in JSONL), it is redacted structurally and re-serialized, so every exported line still parses with JSON.parse.
 * Root cause: text regexes that edit JSON text leave unquoted placeholders, swallow the backslash of `\"`, and cut object values in half.
 * Lines without sensitive content are output unchanged; when a matching line is rewritten, numbers keep their original literals.
 * Lines whose top level is a JSON string (`"{\"password\":…}"`) are also handled structurally; otherwise escaped inner credentials would only pass through the text rules.
 */
function sanitizeSensitiveJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!/^[[{"]/.test(trimmed)) return undefined;
  let result: JsonRedactionResult;
  try {
    result = redactJsonText(trimmed, 0);
  } catch (error) {
    // Lines that are too deeply nested cannot be judged safely level by level, so the whole line is replaced by an explanatory placeholder (still valid JSON); the export continues and the original text is not archived.
    if (error === JSON_DEPTH_EXCEEDED) return JSON_DEPTH_EXCEEDED_LINE;
    throw error;
  }
  if (result.kind === "invalid") return undefined;
  if (result.kind === "unchanged") return line;
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const trailing = line.match(/\s*$/)?.[0] ?? "";
  return `${leading}${result.text}${trailing}`;
}

function sanitizeSensitiveLogChunk(chunk: string): string {
  return chunk.replace(
    /[^\r\n]+/g,
    (line) => sanitizeSensitiveJsonLine(line) ?? sanitizeSensitiveLogContent(line),
  );
}

function detectUtf16EncodingByNullPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let evenByteCount = 0;
  let oddByteCount = 0;
  let evenNullCount = 0;
  let oddNullCount = 0;

  for (let index = 0; index < sample.length; index += 1) {
    if (index % 2 === 0) {
      evenByteCount += 1;
      if (sample[index] === 0) {
        evenNullCount += 1;
      }
      continue;
    }

    oddByteCount += 1;
    if (sample[index] === 0) {
      oddNullCount += 1;
    }
  }

  const evenNullRatio = evenNullCount / Math.max(evenByteCount, 1);
  const oddNullRatio = oddNullCount / Math.max(oddByteCount, 1);
  const likelyUtf16Ratio = 0.3;
  const noiseThreshold = 0.1;
  if (oddNullRatio >= likelyUtf16Ratio && evenNullRatio <= noiseThreshold) {
    return "utf-16le";
  }
  if (evenNullRatio >= likelyUtf16Ratio && oddNullRatio <= noiseThreshold) {
    return "utf-16be";
  }
  return null;
}

function isLikelyAsciiTextByte(byteValue: number): boolean {
  return (
    byteValue === 0x09 ||
    byteValue === 0x0a ||
    byteValue === 0x0d ||
    (byteValue >= 0x20 && byteValue <= 0x7e)
  );
}

function isPreferredTextCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20) {
    return true;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
    return true;
  }
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
    return true;
  }
  if (codePoint >= 0x3000 && codePoint <= 0x303f) {
    return true;
  }
  if (codePoint >= 0xff00 && codePoint <= 0xffef) {
    return true;
  }
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
    return true;
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return true;
  }
  return false;
}

function scoreDecodedTextForEncodingDetection(decodedText: string): TextDecodingScore {
  let totalCodePointCount = 0;
  let preferredCodePointCount = 0;
  let invalidCodePointCount = 0;

  for (const character of decodedText) {
    totalCodePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      codePoint === 0xfffd ||
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      invalidCodePointCount += 1;
      continue;
    }
    if (isPreferredTextCodePoint(codePoint)) {
      preferredCodePointCount += 1;
    }
  }

  const denominator = Math.max(totalCodePointCount, 1);
  return {
    preferredCharRatio: preferredCodePointCount / denominator,
    invalidCharRatio: invalidCodePointCount / denominator,
  };
}

function detectUtf16EncodingByDecodedTextScore(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  const normalizedSampleLength = sample.length - (sample.length % 2);
  if (normalizedSampleLength < 4) {
    return null;
  }
  const normalizedSample = sample.subarray(0, normalizedSampleLength);

  const utf16LeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16le").decode(normalizedSample),
  );
  const utf16BeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16be").decode(normalizedSample),
  );

  const minimumPreferredCharRatio = 0.55;
  const maximumInvalidCharRatio = 0.2;
  const minimumPreferredCharRatioGap = 0.08;

  const utf16LeQualified =
    utf16LeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16LeScore.invalidCharRatio <= maximumInvalidCharRatio;
  const utf16BeQualified =
    utf16BeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16BeScore.invalidCharRatio <= maximumInvalidCharRatio;

  if (utf16LeQualified && !utf16BeQualified) {
    return "utf-16le";
  }
  if (utf16BeQualified && !utf16LeQualified) {
    return "utf-16be";
  }
  if (!utf16LeQualified && !utf16BeQualified) {
    return null;
  }

  const preferredRatioGap = Math.abs(
    utf16LeScore.preferredCharRatio - utf16BeScore.preferredCharRatio,
  );
  if (preferredRatioGap >= minimumPreferredCharRatioGap) {
    return utf16LeScore.preferredCharRatio > utf16BeScore.preferredCharRatio
      ? "utf-16le"
      : "utf-16be";
  }

  return utf16LeScore.invalidCharRatio <= utf16BeScore.invalidCharRatio ? "utf-16le" : "utf-16be";
}

function isValidUtf8Sample(sample: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function detectUtf16EncodingByAsciiPairPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let utf16LeRunLength = 0;
  let utf16BeRunLength = 0;
  let utf16LeAsciiRunScore = 0;
  let utf16BeAsciiRunScore = 0;

  // CJK text can contain a code unit whose low byte happens to be zero (for example, U+4E00).
  // Counting `0x00 + ASCII` pairs directly would mistake this scattered noise for the opposite byte order.
  // Count runs of consecutive ASCII/zero-byte pairs instead, using only contiguous English tokens (API keys/headers) as a valid signal.
  const flushRunScore = (runLength: number): number => (runLength >= 3 ? runLength : 0);

  for (let index = 0; index + 1 < sample.length; index += 2) {
    const leftByte = sample[index] ?? 0;
    const rightByte = sample[index + 1] ?? 0;

    if (rightByte === 0 && isLikelyAsciiTextByte(leftByte)) {
      utf16LeRunLength += 1;
      utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
      utf16BeRunLength = 0;
      continue;
    }
    if (leftByte === 0 && isLikelyAsciiTextByte(rightByte)) {
      utf16BeRunLength += 1;
      utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
      utf16LeRunLength = 0;
      continue;
    }

    utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
    utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
    utf16LeRunLength = 0;
    utf16BeRunLength = 0;
  }

  utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
  utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);

  const minimumAsciiRunScore = 6;
  const dominanceRatio = 1.5;
  if (
    utf16LeAsciiRunScore >= minimumAsciiRunScore &&
    utf16LeAsciiRunScore >= utf16BeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16le";
  }
  if (
    utf16BeAsciiRunScore >= minimumAsciiRunScore &&
    utf16BeAsciiRunScore >= utf16LeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16be";
  }
  return null;
}

function detectTextFileEncoding(sample: Buffer): TextFileEncodingInfo | null {
  if (sample.length === 0) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return {
      encoding: "utf-8",
      bomLength: 3,
      bomBytes: Buffer.from([0xef, 0xbb, 0xbf]),
    };
  }

  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return {
      encoding: "utf-16le",
      bomLength: 2,
      bomBytes: Buffer.from([0xff, 0xfe]),
    };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return {
      encoding: "utf-16be",
      bomLength: 2,
      bomBytes: Buffer.from([0xfe, 0xff]),
    };
  }

  if (!sample.includes(0) && isValidUtf8Sample(sample)) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  // UTF-16 text without a BOM and with a high CJK share may have a low null-byte ratio.
  // A null-ratio-only check could classify it as binary and copy it unchanged, missing sensitive fields.
  // Add an ASCII/zero-byte-pair fallback (for example, `OPENAI_API_KEY=\r\n`) for mixed text found in real logs.
  const utf16Encoding =
    detectUtf16EncodingByAsciiPairPattern(sample) ??
    detectUtf16EncodingByNullPattern(sample) ??
    detectUtf16EncodingByDecodedTextScore(sample);
  if (!utf16Encoding) {
    // UTF-16 text without a BOM or null bytes is common in CJK-only content.
    // Fatal UTF-8 decoding fails on these samples; treating them as UTF-8 would produce mojibake and miss sensitive-field matches.
    // Fallback: use UTF-8 when valid, and classify as binary only when invalid UTF-8 cannot be recognized as UTF-16.
    if (isValidUtf8Sample(sample)) {
      return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
    }
    return null;
  }
  return { encoding: utf16Encoding, bomLength: 0, bomBytes: EMPTY_BOM };
}

async function readFileSample(
  absolutePath: string,
  sampleBytes = TEXT_DETECTION_SAMPLE_BYTES,
): Promise<Buffer> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, sampleBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function encodeTextWithEncoding(text: string, encoding: SupportedTextEncoding): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf-8");
  }
  if (encoding === "utf-16le") {
    return Buffer.from(text, "utf16le");
  }
  const encodedBuffer = Buffer.from(text, "utf16le");
  encodedBuffer.swap16();
  return encodedBuffer;
}

function splitByCompleteLine(content: string): {
  completeChunk: string;
  pendingChunk: string;
} {
  const lastLineFeedIndex = content.lastIndexOf("\n");
  if (lastLineFeedIndex >= 0) {
    return {
      completeChunk: content.slice(0, lastLineFeedIndex + 1),
      pendingChunk: content.slice(lastLineFeedIndex + 1),
    };
  }

  const lastCarriageReturnIndex = content.lastIndexOf("\r");
  if (lastCarriageReturnIndex >= 0 && lastCarriageReturnIndex < content.length - 1) {
    return {
      completeChunk: content.slice(0, lastCarriageReturnIndex + 1),
      pendingChunk: content.slice(lastCarriageReturnIndex + 1),
    };
  }

  return { completeChunk: "", pendingChunk: content };
}

function createSensitiveContentSanitizerTransform(encoding: SupportedTextEncoding): Transform {
  const decoder = new TextDecoder(encoding);
  let pendingChunk = "";

  return new Transform({
    transform(chunk, _chunkEncoding, callback) {
      try {
        const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const decodedChunk = decoder.decode(rawChunk, { stream: true });
        const mergedChunk = `${pendingChunk}${decodedChunk}`;
        const { completeChunk, pendingChunk: nextPendingChunk } = splitByCompleteLine(mergedChunk);
        pendingChunk = nextPendingChunk;

        if (completeChunk.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogChunk(completeChunk);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        const remainingContent = `${pendingChunk}${decoder.decode()}`;
        if (remainingContent.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogChunk(remainingContent);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function sanitizeTextLogFileToDestination(
  sourcePath: string,
  destinationPath: string,
  encodingInfo: TextFileEncodingInfo,
): Promise<void> {
  const readStream = createReadStream(sourcePath, {
    start: encodingInfo.bomLength,
  });
  const writeStream = createWriteStream(destinationPath);

  if (encodingInfo.bomLength > 0) {
    writeStream.write(encodingInfo.bomBytes);
  }

  await pipeline(
    readStream,
    createSensitiveContentSanitizerTransform(encodingInfo.encoding),
    writeStream,
  );
}

function isExcludedCachePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return (
    normalizedRelativePath === "Library/Caches" ||
    normalizedRelativePath.startsWith("Library/Caches/")
  );
}

function isRetiredAcpRuntimePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return RETIRED_ACP_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isHighVolumeRuntimeArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isDocshotArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  const firstSegment = normalizedRelativePath.split("/")[0] ?? "";
  if (DOCSHOT_ARCHIVE_PATHS.includes(firstSegment as (typeof DOCSHOT_ARCHIVE_PATHS)[number])) {
    return true;
  }
  return DOCSHOT_ARCHIVE_PATH_PREFIXES.some((prefix) => firstSegment.startsWith(prefix));
}

function isNonLogStateArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return NON_LOG_STATE_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isSensitiveCredentialArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  const fileName = normalizedRelativePath.split("/").at(-1) ?? "";
  return SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES.has(fileName);
}

function isExcludedDirectoryArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  return normalizedRelativePath
    .split("/")
    .some((segment) => EXCLUDED_ARCHIVE_DIRECTORY_NAMES.has(segment));
}

function isExcludedRelativePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  // Full log export previously redacted file contents but still included credentials.json itself.
  // Credential stores are not troubleshooting logs, and providers may reuse the filename, so skip it by name during collection.
  if (isSensitiveCredentialArchivePath(normalizedRelativePath)) {
    return true;
  }
  // The debug directory usually contains high-frequency model/runtime traces, not material users should share in a log package.
  // Explicitly collecting ~/.zcode/cli/debug used to include these traces in manual/full-feedback exports; skip the directory segment consistently.
  if (isExcludedDirectoryArchivePath(normalizedRelativePath)) {
    return true;
  }
  if (isNonLogStateArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ~/.zcode/v2/dev stores high-frequency protocol streams such as stdio-traffic, which can grow to gigabytes on real machines.
  // They exceed feedback attachment limits and must not be included in diagnostic packages.
  if (isHighVolumeRuntimeArchivePath(normalizedRelativePath)) {
    return true;
  }
  // docshot history backups and asset directories can reach gigabytes and are not diagnostic logs needed for user feedback.
  if (isDocshotArchivePath(normalizedRelativePath)) {
    return true;
  }
  // The ACP runtime directory is retired, but older user data may still contain hundreds of megabytes of captures and old
  // authentication files. Current runtime configuration has moved to agent-config; exporting these old directories would
  // leave users waiting and could expose old proxy certificate private keys.
  if (isRetiredAcpRuntimePath(normalizedRelativePath)) {
    return true;
  }
  // Library/Caches contains runtime cache, not troubleshooting logs; exporting it only enlarges the log package.
  if (isExcludedCachePath(normalizedRelativePath)) {
    return true;
  }

  return ZIP_EXCLUDE_REGEXES.some((pattern) => pattern.test(normalizedRelativePath));
}

function shouldApplyLogExportRetention(archivePath: string): boolean {
  const normalizedArchivePath = normalizeArchivePath(archivePath);
  if (
    normalizedArchivePath.startsWith("logs/") ||
    normalizedArchivePath.startsWith(".zcode/cli/log/")
  ) {
    return true;
  }

  return false;
}

async function filterRecentLogArchiveFiles(
  files: LogArchiveFileEntry[],
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveFileEntry[]> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOG_EXPORT_LOOKBACK_DAYS;
  if (lookbackDays <= 0) {
    return files;
  }

  const now = options.now ?? (() => new Date());
  const cutoffMs = now().getTime() - lookbackDays * MILLISECONDS_PER_DAY;
  const recentFiles: LogArchiveFileEntry[] = [];

  for (const file of files) {
    if (!shouldApplyLogExportRetention(file.archivePath)) {
      recentFiles.push(file);
      continue;
    }

    const fileStats = await stat(file.absolutePath).catch(() => null);
    // Log export used to package entire directories, and old diagnostics could grow to hundreds of MB after long use.
    // Keep only the last three days by mtime for log files whose time window can reproduce the issue.
    // Do not filter troubleshooting configuration such as settings, which may still affect current behavior despite being old.
    if (fileStats?.isFile() && fileStats.mtimeMs >= cutoffMs) {
      recentFiles.push(file);
    }
  }

  return recentFiles;
}

function createAboutContent(): string {
  const snapshot = createAboutSnapshot({ buildMetadata: readBuildMetadata() });
  return formatAboutDetail(snapshot);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSkippedLogArchiveDirectory(
  absolutePath: string,
  archivePath: string,
  error: unknown,
): void {
  logger.warn("[export-logs] Log directory is unreadable; skipped automatically during export", {
    absolutePath,
    archivePath,
    error: formatErrorMessage(error),
  });
}

async function walkLogArchiveDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const resolvedDir = await realpath(absoluteDir).catch(() => absoluteDir);
  if (visitedDirs.has(resolvedDir)) {
    return;
  }
  visitedDirs.add(resolvedDir);

  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch((error: unknown) => {
    // User log sources may contain subdirectories whose permissions are restricted by the OS or third-party CLIs.
    // Skip an individual directory when scandir fails so one EACCES does not abort the entire log export.
    logSkippedLogArchiveDirectory(absoluteDir, relativeDir, error);
    return null;
  });
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));

  for (const dirent of dirents) {
    const archivePath = relativeDir ? posix.join(relativeDir, dirent.name) : dirent.name;
    if (isExcludedRelativePath(archivePath)) {
      continue;
    }

    const absolutePath = join(absoluteDir, dirent.name);
    if (dirent.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (dirent.isFile()) {
      files.push({ absolutePath, archivePath });
      continue;
    }

    if (!dirent.isSymbolicLink()) {
      continue;
    }

    const targetStats = await stat(absolutePath).catch(() => null);
    if (!targetStats) {
      continue;
    }

    // Log directories may contain symlink entries to provider-shared resources.
    // Handle targets by type and deduplicate with realpath to avoid packaging the same content repeatedly or following a cycle.
    if (targetStats.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (targetStats.isFile()) {
      files.push({ absolutePath, archivePath });
    }
  }
}

async function collectLogArchiveFilesFromDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const directoryStats = await stat(absoluteDir).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    return;
  }

  await walkLogArchiveDirectory(absoluteDir, relativeDir, visitedDirs, files);
}

/**
 * Collect one directory level using a filename allowlist; do not recurse. This is for runtime directories where
 * diagnostics and credentials coexist: recursion could include secrets such as .tokens in user-shared log packages,
 * while an EXCLUDED list is reactive and inevitably lags. An allowlist denies by default, so future files are not leaked automatically.
 */
async function collectLogArchiveFilesByName(
  absoluteDir: string,
  relativeDir: string,
  isCollectableFileName: (fileName: string) => boolean,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));
  for (const dirent of dirents) {
    if (!dirent.isFile() || !isCollectableFileName(dirent.name)) {
      continue;
    }
    await collectLogArchiveFile(
      join(absoluteDir, dirent.name),
      posix.join(relativeDir, dirent.name),
      files,
    );
  }
}

async function collectLogArchiveFile(
  absolutePath: string,
  archivePath: string,
  files: LogArchiveFileEntry[],
): Promise<void> {
  if (isExcludedRelativePath(archivePath)) {
    return;
  }
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats?.isFile()) {
    return;
  }
  files.push({ absolutePath, archivePath });
}

export async function collectLogArchiveFiles(sourceDir: string): Promise<LogArchiveFileEntry[]> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();
  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);
  files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  return files;
}

export async function createLogArchiveArtifacts(
  sourceDir: string,
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveArtifacts> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();

  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);

  const zcodeCliLogDir = getZCodeCliLogDir();
  // GLM/zcode-cli runtime logs are under ~/.zcode/cli/log, not the app's main data directory ~/.zcode/v2.
  // Scanning only v2 would omit key native-side logs for agent CLI startup, protocol, or crash issues.
  await collectLogArchiveFilesFromDirectory(
    zcodeCliLogDir,
    posix.join(".zcode", "cli", "log"),
    visitedDirs,
    files,
  );

  // Agent CLI heap-profile records: flat directory, file-name allowlist only, no lookback window (see memory-diagnostics-log.md).
  await collectLogArchiveFilesByName(
    getZCodeCliMemoryDiagnosticsDir(),
    posix.join(".zcode", "cli", CLI_MEMORY_DIAGNOSTICS_DIR_NAME),
    isCliMemoryDiagnosticFileName,
    files,
  );

  const zcodeCliDir = getZCodeCliDir();
  // Troubleshooting agent CLI also requires its runtime configuration and model I/O traces.
  // config.json is the active configuration and rollout contains model-I/O call traces; neither is under ~/.zcode/cli/log,
  // so collect them separately to reconstruct the full situation.
  await collectLogArchiveFile(
    join(zcodeCliDir, "config.json"),
    posix.join(".zcode", "cli", "config.json"),
    files,
  );
  await collectLogArchiveFilesFromDirectory(
    join(zcodeCliDir, "rollout"),
    posix.join(".zcode", "cli", "rollout"),
    visitedDirs,
    files,
  );

  // Include structured diagnostics from Computer Use Helper in log packages. Otherwise grep for
  // "background keyboard begin rejected" returns no matches: LaunchServices starts the Helper and the system discards stderr,
  // so it tees diagnostics to ~/.zcode/computer-use/run/<socket>.exit.log, outside app data and ~/.zcode/cli.
  // The directory also contains .tokens broker credentials, so use a filename allowlist that collects only *.exit.log without recursion.
  await collectLogArchiveFilesByName(
    getCuaHelperRunDir(),
    posix.join(".zcode", "computer-use", "run"),
    isCuaHelperDiagnosticFileName,
    files,
  );

  const recentFiles = await filterRecentLogArchiveFiles(files, options);
  recentFiles.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  return {
    files: recentFiles,
    aboutContent: createAboutContent(),
  };
}

async function copyLogArchiveFilesToDirectory(
  outputPath: string,
  files: LogArchiveFileEntry[],
): Promise<LogArchiveSkippedFileEntry[]> {
  const skippedFiles: LogArchiveSkippedFileEntry[] = [];

  for (const file of files) {
    const destinationPath = join(outputPath, ...file.archivePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true });

    const sourceStats = await stat(file.absolutePath).catch((error: unknown) => {
      skippedFiles.push({
        absolutePath: file.absolutePath,
        archivePath: file.archivePath,
        error: formatErrorMessage(error),
      });
      return null;
    });
    if (!sourceStats?.isFile()) {
      continue;
    }

    const sourceReadable = await access(file.absolutePath, constants.R_OK)
      .then(() => true)
      .catch((error: unknown) => {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        return false;
      });
    if (!sourceReadable) {
      continue;
    }

    try {
      // Use sampled encoding detection plus streaming redaction to avoid the memory spike from readFile on large files.
      // Explicitly support UTF-16 text both with and without a BOM so it is not misclassified as binary and copied with sensitive fields intact.
      const sourceSample = await readFileSample(file.absolutePath);
      const textEncodingInfo = detectTextFileEncoding(sourceSample);
      if (!textEncodingInfo) {
        await copyFile(file.absolutePath, destinationPath);
      } else {
        await sanitizeTextLogFileToDestination(
          file.absolutePath,
          destinationPath,
          textEncodingInfo,
        );
      }
    } catch (error) {
      const sourceStatsAfterFailure = await stat(file.absolutePath).catch(() => null);
      const sourceReadableAfterFailure = sourceStatsAfterFailure?.isFile()
        ? await access(file.absolutePath, constants.R_OK)
            .then(() => true)
            .catch(() => false)
        : false;
      // Telemetry/agent logs may be rotated, deleted, or have permissions changed after the export list is scanned;
      // symlink targets may also disappear during that interval. If copying fails, check source readability again.
      // If the source is no longer readable, skip the bad file so a single ENOENT/EACCES does not abort the export.
      if (!sourceReadableAfterFailure) {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        continue;
      }
      throw error;
    }
  }

  return skippedFiles;
}

function logSkippedLogArchiveFiles(skippedFiles: LogArchiveSkippedFileEntry[]): void {
  if (skippedFiles.length === 0) {
    return;
  }

  logger.warn("[export-logs] Unreadable log file detected; skipped automatically during export", {
    skippedCount: skippedFiles.length,
    skippedFiles: skippedFiles.slice(0, 10),
  });
}

export async function writeLogArchiveZip(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
  options: WriteLogArchiveZipOptions = {},
): Promise<void> {
  const stageRootDir = options.stageRootDir ?? getDefaultExportLogStageDir();
  await mkdir(stageRootDir, { recursive: true });
  const stagingDir = await mkdtemp(join(stageRootDir, "stage-"));
  try {
    // yazl.addFile calls fs.stat/createReadStream on the source path again.
    // For symlink targets or telemetry files being rotated, this may still throw asynchronously and trigger an unhandled error event.
    // Copy readable files to a stable temporary directory first, then compress from there so ZIP processing sees only regular files we control.
    await writeLogArchiveDirectory(stagingDir, artifacts);

    const zipFile = new ZipFile();
    const stageFiles = await collectLogArchiveFiles(stagingDir);
    const outputStream = createWriteStream(outputPath);
    zipFile.once("error", (error) => {
      outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    for (const file of stageFiles) {
      zipFile.addFile(file.absolutePath, file.archivePath);
    }

    const writePromise = pipeline(zipFile.outputStream, outputStream);
    zipFile.end();
    await writePromise;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeLogArchiveDirectory(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
): Promise<void> {
  await mkdir(outputPath, { recursive: true });
  const skippedFiles = await copyLogArchiveFilesToDirectory(outputPath, artifacts.files);
  logSkippedLogArchiveFiles(skippedFiles);

  await writeFile(join(outputPath, "about.txt"), artifacts.aboutContent, "utf-8");
}

export async function createFeedbackLogArchiveFromExportLogs(
  sourceDir: string,
  options: CreateFeedbackLogArchiveFromExportLogsOptions = {},
): Promise<{ path: string; size: number }> {
  return createFeedbackDiagnosticArchive({
    sources: [
      {
        directory: getZCodeCliMemoryDiagnosticsDir(),
        archivePrefix: ".zcode/cli/memory-diagnostics",
        contentPolicy: "cli-memory",
        onlyCurrentDay: false,
      },
      { directory: join(sourceDir, "logs"), archivePrefix: "logs" },
      { directory: getZCodeCliLogDir(), archivePrefix: ".zcode/cli/log" },
      {
        directory: getZCodeCliDir(),
        archivePrefix: ".zcode/cli",
        includeFileNames: ["config.json"],
        onlyCurrentDay: false,
        contentPolicy: "cli-config",
      },
      {
        directory: join(getZCodeCliDir(), "rollout"),
        archivePrefix: ".zcode/cli/rollout",
      },
      {
        directory: getCuaHelperRunDir(),
        archivePrefix: ".zcode/computer-use/run",
        exitLogsOnly: true,
      },
    ],
    outputRootDir: options.outputRootDir ?? getDefaultFeedbackLogArchiveDir(),
    now: options.now,
    onProgress: options.onProgress,
  });
}

export async function exportLogs(
  dependencies: ExportLogsDependencies = {},
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const now = dependencies.now ?? (() => new Date());
    const getSourceDir = dependencies.getZCodeDataDir ?? getZCodeDataDir;
    const buildArtifacts = dependencies.createLogArchiveArtifacts ?? createLogArchiveArtifacts;
    const writeZip = dependencies.writeLogArchiveZip ?? writeLogArchiveZip;
    const writeDirectory = dependencies.writeLogArchiveDirectory ?? writeLogArchiveDirectory;
    const showItemInFolder =
      dependencies.showItemInFolder ??
      (async (path: string) => {
        const { shell } = await import("electron");
        shell.showItemInFolder(path);
      });
    const getStageRootDir = dependencies.getExportLogStageDir ?? getDefaultExportLogStageDir;
    const getOutputRootDir = dependencies.getExportLogDir ?? getDefaultExportLogDir;

    const sourceDir = getSourceDir();
    const timestamp = formatTimestamp(now());
    const exportBaseName = `zcode-logs-${timestamp}`;
    const outputRootDir = getOutputRootDir();
    await mkdir(outputRootDir, { recursive: true });
    const outputDir = await mkdtemp(join(outputRootDir, `${exportBaseName}-`));
    const zipPath = join(outputDir, `${exportBaseName}.zip`);
    const directoryPath = join(outputDir, exportBaseName);

    logger.info("[export-logs] Start packaging logs", {
      source: sourceDir,
      zipDest: zipPath,
      directoryDest: directoryPath,
    });
    const artifacts = await buildArtifacts(sourceDir, { now });

    try {
      await writeZip(zipPath, artifacts, { stageRootDir: getStageRootDir() });
      await showItemInFolder(zipPath);

      logger.info("[export-logs] Log export complete", {
        path: zipPath,
        format: "zip",
      });
      return { success: true, path: zipPath };
    } catch (zipError) {
      const zipErrorMessage = zipError instanceof Error ? zipError.message : String(zipError);

      // Windows compression no longer depends on PowerShell/.NET, but archive writes can still be interrupted by antivirus,
      // disk policy, or other external factors. Fall back to directory export so users can still reliably get the raw logs instead of an error.
      logger.warn("[export-logs] zip export failed; falling back to directory export", {
        error: zipErrorMessage,
        zipPath,
        fallbackPath: directoryPath,
      });
      await rm(zipPath, { force: true }).catch(() => {});

      try {
        await writeDirectory(directoryPath, artifacts);
      } catch (directoryError) {
        const directoryErrorMessage =
          directoryError instanceof Error ? directoryError.message : String(directoryError);
        throw new Error(
          `zip export failed: ${zipErrorMessage}; directory export failed: ${directoryErrorMessage}`,
        );
      }

      await showItemInFolder(directoryPath);
      logger.info("[export-logs] Log export complete", {
        path: directoryPath,
        format: "directory",
      });
      return { success: true, path: directoryPath };
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    logger.error("[export-logs] Log export failed", { error: message });
    return { success: false, error: message };
  }
}
