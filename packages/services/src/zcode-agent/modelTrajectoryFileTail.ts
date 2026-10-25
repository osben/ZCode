import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataBaseDir } from "#src/paths.js";
import type { ZCodeModelTrajectoryTruncation } from "#src/session/zcodeTaskService.js";

// 32 MiB covers typical recent calls while avoiding Host memory spikes from 64/256 MiB diagnostic files.
const MAX_TRAJECTORY_READ_BYTES = 32 * 1024 * 1024;

export interface TrajectoryFileTail {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

// Try both debug (development) and rollout (production) locations to handle differences in data-directory environment variables.
export function resolveModelIODirs(): string[] {
  const roots = new Set<string>([
    join(homedir(), ".zcode", "cli"),
    join(getDataBaseDir(), ".zcode", "cli"),
  ]);
  return [...roots].flatMap((root) => [join(root, "debug"), join(root, "rollout")]);
}

// Match sanitizeFileSegment in runner-debug.ts: retain only filename-safe characters.
export function sanitizeSessionSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function readTrajectoryFileTail(filePath: string): Promise<TrajectoryFileTail> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_TRAJECTORY_READ_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }

    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return { text, bytesRead, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

// Per-segment projection budget (docs/model-trajectory-viewer.md, "数据来源"): 16 KiB of output in total,
// separator included. Head is 12 KiB; the tail takes what remains, so a cut output never exceeds the budget.
// Sized from the 5-call session fixture (sess_1293b371, 825-834 messages per call): 16 KiB cuts 30 of 3144 segments (6 in the first call).
const PART_BUDGET_BYTES = 16 * 1024;
const TRUNCATION_SEPARATOR = "\n…\n";
const SEPARATOR_BYTES = Buffer.byteLength(TRUNCATION_SEPARATOR, "utf8");
const PART_HEAD_BYTES = 12 * 1024;
const PART_TAIL_BYTES = PART_BUDGET_BYTES - SEPARATOR_BYTES - PART_HEAD_BYTES;

/**
 * Cut a text segment to PART_BUDGET_BYTES. Head and tail are taken on UTF-8 character boundaries so the
 * projected string never contains a split code point; the elided middle is replaced by TRUNCATION_SEPARATOR.
 */
export function boundText(text: string): {
  text: string;
  truncated?: ZCodeModelTrajectoryTruncation;
} {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= PART_BUDGET_BYTES) return { text };
  const buffer = Buffer.from(text, "utf8");
  let headEnd = PART_HEAD_BYTES;
  while (headEnd > 0 && isUtf8Continuation(buffer[headEnd])) headEnd -= 1;
  let tailStart = buffer.length - PART_TAIL_BYTES;
  while (tailStart < buffer.length && isUtf8Continuation(buffer[tailStart])) tailStart += 1;
  const keptBytes = headEnd + (buffer.length - tailStart);
  return {
    text:
      buffer.subarray(0, headEnd).toString("utf8") +
      TRUNCATION_SEPARATOR +
      buffer.subarray(tailStart).toString("utf8"),
    truncated: { originalBytes, omittedBytes: originalBytes - keptBytes },
  };
}

/**
 * Bound an arbitrary tool payload. Strings and error-text objects keep their shape; other values are
 * serialized and cut as text when their JSON form exceeds the budget, so the output type becomes a string.
 */
export function boundPayload(value: unknown): {
  value: unknown;
  truncated?: ZCodeModelTrajectoryTruncation;
} {
  if (typeof value === "string") {
    const bounded = boundText(value);
    return { value: bounded.text, truncated: bounded.truncated };
  }
  if (isErrorTextPayload(value)) {
    const bounded = boundText(value.value);
    return bounded.truncated
      ? { value: { type: "error-text", value: bounded.text }, truncated: bounded.truncated }
      : { value };
  }
  if (isContentWrapper(value)) {
    // The UI unwraps {content} to its string, so cut the inner string: small and large outputs then render alike.
    const bounded = boundText(value.content);
    return bounded.truncated ? { value: bounded.text, truncated: bounded.truncated } : { value };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value };
  }
  if (json === undefined || Buffer.byteLength(json, "utf8") <= PART_BUDGET_BYTES) {
    return { value };
  }
  const bounded = boundText(json);
  return { value: bounded.text, truncated: bounded.truncated };
}

function isContentWrapper(value: unknown): value is { content: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? typeof (value as { content?: unknown }).content === "string"
    : false;
}

function isErrorTextPayload(value: unknown): value is { type: "error-text"; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "error-text" &&
    typeof (value as { value?: unknown }).value === "string"
  );
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

export function withTruncation<T extends object>(
  part: T,
  truncated: ZCodeModelTrajectoryTruncation | undefined,
): T & { truncated?: ZCodeModelTrajectoryTruncation } {
  return truncated ? { ...part, truncated } : part;
}
