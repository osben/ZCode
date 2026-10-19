// ============================================================
// Nested instructions: what the model can currently see
// ============================================================
// Delivered state is derived from provider-visible history, not kept in a session Set. Microcompaction, compaction,
// resume and rewind all change that history, so the answer follows what the model still has without extra sync points.

import { modelMessageContentToText } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { FILE_UNCHANGED_STUB } from "../../tool/read-file-state-metadata.js";
import { nestedInstructionKey, resolveNestedInstructionPath } from "./touched-paths.js";

export interface NestedInstructionHistory {
  /** Normalized keys of nested files already visible to the model. */
  delivered: ReadonlySet<string>;
  /** Injected bytes of nested reminders still visible to the model. */
  bytesDelivered: number;
}

/**
 * Marker written as the first lines of every nested reminder. `path` is a JSON string, so quotes and backslashes in a
 * folder name cannot end the field early.
 */
const NESTED_MARKER_PREFIX = "[nested-agents-md ";
const NESTED_MARKER_LINE = /^\[nested-agents-md path=("(?:[^"\\\n]|\\.)*") bytes=(\d+)\]$/;
/** Opening tag of a reminder body, as produced by `wrapSystemReminder`. */
const SYSTEM_REMINDER_OPEN = "<system-reminder>\n";
/**
 * First line of every numbered Read body (`addReadLineNumbers`). Stubs and cleared results do not contain it.
 * Anchored to the start of a line so the body text itself is not matched mid-line.
 */
const READ_BODY_FIRST_LINE = /(?:^|\n)1\t/;

export function formatNestedInstructionMarker(absolutePath: string, bytes: number): string {
  return `[nested-agents-md path=${JSON.stringify(absolutePath)} bytes=${bytes}]`;
}

/**
 * `workingDirectory` is the live session cwd: a relative `file_path` in history resolves against it, the same way the
 * Read handler resolves it for the current call, so it keys the same file as discovery.
 */
export function readNestedInstructionHistory(
  entries: readonly RuntimeMessageEntry[],
  platform: NodeJS.Platform,
  workingDirectory: string,
): NestedInstructionHistory {
  const delivered = new Set<string>();
  let bytesDelivered = 0;
  // Full Read calls whose results have not been seen yet, keyed by tool call id.
  const pendingFullReads = new Map<string, string>();

  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;

    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call.name !== "Read") continue;
        const key = fullReadKey(call.input, platform, workingDirectory);
        if (key !== undefined) pendingFullReads.set(call.id, key);
      }
      continue;
    }

    // Tool results are stored as `tool` messages, or as `user` messages carrying a toolCallId.
    if (message.toolCallId === undefined) continue;
    if (message.isError === true) {
      pendingFullReads.delete(message.toolCallId);
      continue;
    }

    const text = modelMessageContentToText(message.content);
    const pendingKey = pendingFullReads.get(message.toolCallId);
    if (pendingKey !== undefined) {
      // A fresh-cache Read returns the stub, which points at an earlier result. Only a result that still carries the
      // numbered body proves the model saw the file.
      if (text !== FILE_UNCHANGED_STUB && READ_BODY_FIRST_LINE.test(text)) delivered.add(pendingKey);
      pendingFullReads.delete(message.toolCallId);
    }

    // Only the reminder's own marker lines count. Text after the marker lines is repository-controlled file content.
    for (const marker of readReminderMarkers(text)) {
      delivered.add(nestedInstructionKey(marker.path, platform));
      bytesDelivered += marker.bytes;
    }
  }

  return { delivered, bytesDelivered };
}

/**
 * Reads the marker lines at the head of each reminder block. The parser stops at the first line that is not a marker,
 * so the AGENTS.md body that follows the markers is never scanned for them.
 */
function readReminderMarkers(text: string): Array<{ path: string; bytes: number }> {
  if (!text.includes(NESTED_MARKER_PREFIX)) return [];
  const markers: Array<{ path: string; bytes: number }> = [];
  let from = 0;
  while (from < text.length) {
    const open = text.indexOf(SYSTEM_REMINDER_OPEN, from);
    if (open < 0) break;
    let cursor = open + SYSTEM_REMINDER_OPEN.length;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      const lineEnd = newline < 0 ? text.length : newline;
      const match = NESTED_MARKER_LINE.exec(text.slice(cursor, lineEnd));
      if (!match) break;
      const parsedPath = parseMarkerPath(match[1]);
      if (parsedPath !== undefined) markers.push({ path: parsedPath, bytes: Number(match[2]) });
      cursor = lineEnd + 1;
    }
    from = cursor;
  }
  return markers;
}

function fullReadKey(
  input: unknown,
  platform: NodeJS.Platform,
  workingDirectory: string,
): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const fields = input as { file_path?: unknown; offset?: unknown; limit?: unknown };
  // Only a whole-file read returns the full AGENTS.md content; a range read does not count.
  if (fields.offset !== undefined && fields.offset !== null) return undefined;
  if (fields.limit !== undefined && fields.limit !== null) return undefined;
  if (typeof fields.file_path !== "string" || fields.file_path.length === 0) return undefined;
  return nestedInstructionKey(
    resolveNestedInstructionPath(fields.file_path, workingDirectory, platform),
    platform,
  );
}

function parseMarkerPath(encoded: string | undefined): string | undefined {
  if (encoded === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(encoded);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
