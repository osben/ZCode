// ============================================================
// “Was a skill loaded in this history?” (docs/dynamic-workflow/authoring.md, “The authoring surface”)
// ============================================================
// The skill gate for workflow-creation tools (tool/handlers/workflow-skill-gate.ts) asks this question. Read the answer deliberately from
// the runtime's provider-visible history rather than creating a session-level Set: history is what the model remembers now.
// If compaction removes that Skill call, its contents are gone too, and the gate should close again; when resume/rewind rebuilds history,
// the answer is rebuilt with it, without a second hydration path.

import type { RuntimeMessageEntry } from "./message-history.js";

const SKILL_TOOL_NAME = "Skill";

/**
 * Whether a **successfully completed** `Skill` call in the history loaded `skillName`.
 *
 * Success means the assistant call has a corresponding tool result entry that is not an error. A call with no result yet (still running or rejected)
 * or a result with `isError` does not count. Recognize both the current `{ skill }` and legacy `{ name }` skill-name shapes
 * (both are accepted by contracts' SkillInputSchema).
 */
export function sessionHasLoadedSkill(
  entries: readonly RuntimeMessageEntry[],
  skillName: string,
): boolean {
  const pendingCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call.name === SKILL_TOOL_NAME && skillInputNames(call.input) === skillName) {
          pendingCallIds.add(call.id);
        }
      }
      continue;
    }
    if (
      message.role === "tool" &&
      message.toolCallId !== undefined &&
      pendingCallIds.has(message.toolCallId) &&
      message.isError !== true
    ) {
      return true;
    }
  }
  return false;
}

function skillInputNames(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const fields = input as { skill?: unknown; name?: unknown };
  if (typeof fields.skill === "string") return fields.skill;
  if (typeof fields.name === "string") return fields.name;
  return undefined;
}
