// ============================================================
// Nested AGENTS.md delivery for a successful tool call
// ============================================================
// Appends newly discovered folder instructions to the same tool result that touched the folder. The provider prefix and
// system prompt are untouched; the reminder lives in the tool turn, like hook additional context.
// All-or-nothing: the reminder is either appended whole or not at all. A marker line without its body would make the
// history probe count the file as delivered while the model never saw it.

import { discoverNestedInstructions } from "../../context/nested-instructions/discover.js";
import { resolveNestedInstructionTargets } from "../../context/nested-instructions/touched-paths.js";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";
import type { ToolEntry, ToolResultSerialization } from "../types.js";
import {
  FORMATTED_CONTEXT_SEPARATOR,
  appendFormattedContextToSerialization,
  resolveFormattedContextBudgetBytes,
} from "./result-serialization.js";
import type { ToolExecutorDeps } from "./types.js";

const NESTED_REMINDER_SOURCE = "nested_agents_md";

function formatNestedReminder(lines: readonly string[]): string {
  return wrapSystemReminderForSource(NESTED_REMINDER_SOURCE, lines);
}

export async function appendNestedInstructions(
  deps: ToolExecutorDeps,
  input: unknown,
  output: unknown,
  entry: ToolEntry,
  serialization: ToolResultSerialization,
  signal: AbortSignal | undefined,
): Promise<ToolResultSerialization> {
  const context = deps.nestedInstructions;
  const fileSystem = deps.fileSystemPort;
  if (!context || !fileSystem) return serialization;

  try {
    const targets = resolveNestedInstructionTargets({
      toolName: entry.metadata.name,
      toolInput: input,
      toolOutput: output,
      workingDirectory: deps.getWorkingDirectory(),
      platform: process.platform,
    });
    if (targets.locations.length === 0) return serialization;

    // The result budget is known only after serialization and hook contexts, so discovery receives what is left.
    const reminderLines = await discoverNestedInstructions({
      ...context,
      ...targets,
      workspaceRoot: deps.getWorkspaceRoot(),
      maxReminderBytes: resolveFormattedContextBudgetBytes(serialization, entry),
      measureReminderBytes: (lines) => Buffer.byteLength(formatNestedReminder(lines), "utf8"),
      platform: process.platform,
      fileSystem,
      now: Date.now(),
      signal,
      logger: deps.logger,
    });
    if (!reminderLines) return serialization;

    const reminder = formatNestedReminder(reminderLines);
    const appended = appendFormattedContextToSerialization(serialization, reminder, entry);
    // Defensive guard for the all-or-nothing rule. The appender may cut the suffix (artifact previews) or the result
    // text (plain results) to fit its own budget; either way the reminder is incomplete, so keep the result unchanged.
    if (appended.content !== `${serialization.content}${FORMATTED_CONTEXT_SEPARATOR}${reminder}`) {
      deps.logger?.debug("Nested instructions dropped: reminder would not fit whole", {
        event: "instructions.nested.skipped",
        module: "core.tool.executor",
        reason: "reminder_not_whole",
      });
      return serialization;
    }
    return appended;
  } catch (error) {
    // Discovery is best-effort: a failure here must never fail a tool call that already succeeded.
    deps.logger?.debug("Nested instruction discovery failed", {
      event: "instructions.nested.skipped",
      module: "core.tool.executor",
      reason: error instanceof Error ? error.name : "unknown",
    });
    return serialization;
  }
}
