// ============================================================
// Nested AGENTS.md delivery for a successful tool call
// ============================================================
// Appends newly discovered folder instructions to the same tool result that touched the folder. The provider prefix and
// system prompt are untouched; the reminder lives in the tool turn, like hook additional context.

import { discoverNestedInstructions } from "../../context/nested-instructions/discover.js";
import { resolveNestedInstructionTargets } from "../../context/nested-instructions/touched-paths.js";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";
import type { ToolEntry, ToolResultSerialization } from "../types.js";
import { appendFormattedContextToSerialization } from "./result-serialization.js";
import type { ToolExecutorDeps } from "./types.js";

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

    const reminderBody = await discoverNestedInstructions({
      ...context,
      ...targets,
      workspaceRoot: deps.getWorkspaceRoot(),
      platform: process.platform,
      fileSystem,
      now: Date.now(),
      signal,
      logger: deps.logger,
    });
    if (!reminderBody) return serialization;

    return appendFormattedContextToSerialization(
      serialization,
      wrapSystemReminderForSource("nested_agents_md", reminderBody),
      entry,
    );
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
