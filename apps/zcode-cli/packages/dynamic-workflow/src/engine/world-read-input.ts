// ============================================================
// Bounded input for world-read / world-run nodes
// ============================================================
// `inputHash` only answers “is this the same input?”; the workspace transcript must answer “what
// was the input?” This keeps `{op, args}` within 4 KB. Most inputs (a path, pattern, or argv) are
// well below the limit and are stored as-is; only cases such as `world.run("node", ["-e", <a long
// script>])` are truncated. Truncation uses **per-item string previews** instead of dropping the
// whole input—audit logs gain more from “ran node -e … (truncated)” than from NULL.

import { WORLD_READ_INPUT_MAX_BYTES, type WorldReadInput } from "./types.js";

/** Maximum characters retained for one argument in truncation mode: divide 4 KB among up to 8 arguments and leave room for serialization overhead. */
const TRUNCATED_ARG_MAX_CHARS = 400;
const MAX_ARGS_KEPT = 8;

/** UTF-8 byte length. Use `TextEncoder` instead of `Buffer` to keep this package free of Node built-in dependencies (the same rule as engine.ts). */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** String preview of one argument: strings as-is, everything else as JSON; truncate long values and append an ellipsis. */
function previewArg(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > TRUNCATED_ARG_MAX_CHARS
    ? `${text.slice(0, TRUNCATED_ARG_MAX_CHARS)}…`
    : text;
}

/**
 * Keep `{op, args}` within {@link WORLD_READ_INPUT_MAX_BYTES}.
 *
 * Fast path: if serialization stays within the limit, return it as-is (arguments retain their
 * original types—the opts object for `world.run` and numeric values for `git.log` remain unchanged).
 * Slow path: replace each argument with a string preview, retain at most 8, and set `truncated`.
 * Unserializable arguments (circular references, BigInt) use the same slow path because the journal
 * cannot represent them anyway.
 */
export function boundWorldReadInput(op: string, args: readonly unknown[]): WorldReadInput {
  const plain: WorldReadInput = { op, args: [...args] };
  try {
    const text = JSON.stringify(plain);
    if (text !== undefined && utf8Length(text) <= WORLD_READ_INPUT_MAX_BYTES) return plain;
  } catch {
    // Fall through to the preview path below.
  }
  return {
    op,
    args: args.slice(0, MAX_ARGS_KEPT).map(previewArg),
    truncated: true,
  };
}
