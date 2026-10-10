// Persistent description for SaveWorkflow.
//
// The `dynamic-workflows` skill's “Tool reference” documents file format, argument declarations, and authoring rules; the skill gate
// ensures it has been read. Keep the one rule that must be visible **before deciding whether to call the tool** here: never save
// proactively. Saving writes a file into the user's repository, and the model is far more permissive than the user about what “looks
// reusable”; this requirement must be available before the skill loads.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

export const SAVE_WORKFLOW_TOOL_DESCRIPTION = [
  "Save a dynamic-workflow script with its metadata so it can be run again later by name (CreateWorkflow's `saved` source; ListSavedWorkflows lists them). The required `scope` decides whether it lives in this project or globally.",
  "",
  "NEVER call this tool unsolicited: saving writes a file into the user's repository, and that is their decision. When a workflow you just built looks reusable, suggest saving it in one sentence and wait; call SaveWorkflow only after the user agrees, or when the user asks directly.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool first: it carries the file format, the argument declarations and the authoring rules. The call is refused until that skill has been loaded in this session. Pass \`script\` (the body only) or \`script_path\` (a draft file, saved without re-emitting it), never both.`,
].join("\n");
