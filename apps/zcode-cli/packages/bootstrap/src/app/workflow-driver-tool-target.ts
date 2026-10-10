// ============================================================
// Tool call → a human-readable target hint.
// ============================================================
// `lastTool.target` in `node-progress` answers "what is it working on?": file tools provide a path, Bash provides a command prefix,
// and search tools provide a pattern. It is **not the arguments**—those may contain a full patch, base64 data, or file contents. This event is read by the main agent
// as context and shown on GUI cards, so keep only a bounded scalar key and treat everything else as unrecognized.
//
// Match by **key name**, not tool name: tool names can change, and MCP tool names are outside our control. Keys such as `file_path` / `command`
// are established conventions in this repository's tool arguments (contracts read/edit/write/bash/glob/grep schemas).
// If unrecognized, omit the hint—an "(unknown)" placeholder could be mistaken for a real target.

import {
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  type AskLastTool,
} from "@zcode/dynamic-workflow";

/**
 * Argument keys to check in priority order. The first **non-empty string** is the target. Preserve the end for path keys (the filename distinguishes paths),
 * and the beginning for others (command, pattern, and URL prefixes are most identifying).
 */
const TARGET_KEYS: readonly { key: string; keep: "head" | "tail" }[] = [
  { key: "file_path", keep: "tail" },
  { key: "notebook_path", keep: "tail" },
  { key: "path", keep: "tail" },
  { key: "command", keep: "head" },
  { key: "pattern", keep: "head" },
  { key: "url", keep: "head" },
  { key: "query", keep: "head" },
];

/** Ellipsis marker (prefixed when preserving the tail) so readers can tell the hint was truncated. */
const ELLIPSIS = "…";

/** Narrow view of one tool call: name + arguments. Either may be absent (legacy event or unnamed call). */
interface ToolCallSummaryInput {
  toolName?: string;
  input?: unknown;
}

/**
 * Reduce a tool call to `lastTool`. If the name is absent, omit the whole value—a "most recent tool" with no name says nothing.
 */
export function summarizeToolCall(call: ToolCallSummaryInput): AskLastTool | undefined {
  const name = typeof call.toolName === "string" ? call.toolName.trim() : "";
  if (name.length === 0) return undefined;
  const target = deriveToolTarget(call.input);
  return {
    name: name.slice(0, LAST_TOOL_NAME_MAX_CHARS),
    ...(target === undefined ? {} : { target }),
  };
}

/** Extract a target hint from arguments; omit it if they are not an object, have no known key, or the key is not a non-empty string. */
function deriveToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const { key, keep } of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    // For multiline commands, use only the first line and collapse repeated whitespace: the command prefix shows what is running, not the whole heredoc.
    const flattened = value.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
    if (flattened.length === 0) continue;
    return bound(flattened, keep);
  }
  return undefined;
}

/** Truncate to {@link LAST_TOOL_TARGET_MAX_CHARS}: slice directly when preserving the beginning; prefix an ellipsis before slicing when preserving the end. */
function bound(text: string, keep: "head" | "tail"): string {
  if (text.length <= LAST_TOOL_TARGET_MAX_CHARS) return text;
  if (keep === "head") return text.slice(0, LAST_TOOL_TARGET_MAX_CHARS);
  return ELLIPSIS + text.slice(text.length - (LAST_TOOL_TARGET_MAX_CHARS - ELLIPSIS.length));
}
