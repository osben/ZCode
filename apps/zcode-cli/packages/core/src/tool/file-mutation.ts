// ============================================================
// FileMutated publication for Write and Edit (spec §4, §6)
// ============================================================
// Edit and Write never call a language server. They publish the mutation, and the LSP document
// sync decides what to send. Publication happens only after a successful write.

import type { FileMutatedEvent } from "@zcode/contracts";
import { changedRangeBetweenLines } from "../lsp/results.js";
import { splitLines } from "../lsp/position.js";
import type { ToolExecutionContext } from "./types.js";

export function publishFileMutation(
  context: ToolExecutionContext,
  event: Omit<FileMutatedEvent, "traceId" | "sessionId">,
): void {
  context.fileMutationSink?.({
    ...event,
    traceId: context.traceId,
    sessionId: context.sessionId,
  });
}

/** Changed range for a whole-file write: a created file is one range, an overwrite is the differing lines. */
export function writeChangedRange(
  originalContent: string | null,
  newContent: string,
): { startLine: number; endLine: number } {
  const newLines = splitLines(newContent);
  if (originalContent === null) {
    return { startLine: 1, endLine: Math.max(1, newLines.length) };
  }
  return changedRangeBetweenLines(splitLines(originalContent), newLines);
}
