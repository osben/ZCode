// ============================================================
// Nested instructions: what the model can currently see
// ============================================================
// Delivered state is derived from provider-visible history, not kept in a session Set. Microcompaction, compaction,
// resume and rewind all change that history, so the answer follows what the model still has without extra sync points.

import { modelMessageContentToText } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { nestedInstructionKey } from "./touched-paths.js";

export interface NestedInstructionHistory {
  /** Normalized keys of nested files already visible to the model. */
  delivered: ReadonlySet<string>;
  /** Injected bytes of nested reminders still visible to the model. */
  bytesDelivered: number;
}

/**
 * Marker written into every nested reminder. `path` is a JSON string, so quotes and backslashes in a folder name
 * cannot end the field early.
 */
const NESTED_MARKER_PREFIX = "[nested-agents-md ";
const NESTED_MARKER_PATTERN = /\[nested-agents-md path=("(?:[^"\\\n]|\\.)*") bytes=(\d+)\]/g;

export function formatNestedInstructionMarker(absolutePath: string, bytes: number): string {
  return `[nested-agents-md path=${JSON.stringify(absolutePath)} bytes=${bytes}]`;
}

export function readNestedInstructionHistory(
  entries: readonly RuntimeMessageEntry[],
  platform: NodeJS.Platform,
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
        const key = fullReadKey(call.input, platform);
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

    const pendingKey = pendingFullReads.get(message.toolCallId);
    if (pendingKey !== undefined) {
      delivered.add(pendingKey);
      pendingFullReads.delete(message.toolCallId);
    }

    const text = modelMessageContentToText(message.content);
    if (!text.includes(NESTED_MARKER_PREFIX)) continue;
    for (const match of text.matchAll(NESTED_MARKER_PATTERN)) {
      const parsedPath = parseMarkerPath(match[1]);
      if (parsedPath === undefined) continue;
      delivered.add(nestedInstructionKey(parsedPath, platform));
      bytesDelivered += Number(match[2]);
    }
  }

  return { delivered, bytesDelivered };
}

function fullReadKey(input: unknown, platform: NodeJS.Platform): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const fields = input as { file_path?: unknown; offset?: unknown; limit?: unknown };
  // Only a whole-file read returns the full AGENTS.md content; a range read does not count.
  if (fields.offset !== undefined && fields.offset !== null) return undefined;
  if (fields.limit !== undefined && fields.limit !== null) return undefined;
  if (typeof fields.file_path !== "string" || fields.file_path.length === 0) return undefined;
  return nestedInstructionKey(fields.file_path, platform);
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
