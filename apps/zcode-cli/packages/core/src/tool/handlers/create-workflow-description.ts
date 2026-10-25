// Persistent description for CreateWorkflow (docs/dynamic-workflow/authoring.md, “The authoring surface”).
//
// Intentionally shortened starting 2026-09-21: the facade declaration, writing rules, phase and naming rules, and full field semantics
// moved to the “Tool reference” section of the `dynamic-workflows` skill. The resolveInput skill gate
// (handlers/workflow-skill-gate.ts) ensures the model has read it before writing a script. This description and the facade previously
// used about 8k tokens, resent with every model request; it now keeps only three persistent essentials—what the tool is, when (not) to use it,
// and to read the skill first. Routing rules stay here rather than in the skill because they determine whether to call this tool and must be read before the skill loads.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

const INTRO =
  "Create and run a dynamic workflow: a TypeScript script that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results. The script is typechecked, the user is asked to confirm it, and the run starts in the background; you are notified with its final result when it settles. Compilation errors come back as diagnostics.";

/**
 * Route only by whether the user explicitly requested it (user decision on 2026-09-16; docs/dynamic-workflow/launch.md, “When the
 * model may call it”): workflows can start only through `/workflow` or an explicit request; the model must not start one on its own.
 */
const WHEN_TO_USE = [
  "When to use:",
  '- The user explicitly asks for a workflow — "use a workflow", "with a workflow", or the same request in any language that names a workflow as the means: this tool is mandatory. Do not substitute the Agent/Task subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow — the user chose the tool, and that choice is theirs. Size only decides how many subagents the script gets, never whether it is written.',
  "- Without such an explicit request, do not start a workflow: delegate with the Agent tool or do the work yourself, even for multi-step or multi-subagent tasks.",
].join("\n");

const SKILL_GATE = `Before writing or revising a script, load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool: it carries the facade declarations the script is checked against, the authoring rules, and this tool's full contract. A call that submits a script is refused until that skill has been loaded in this session; running a saved workflow by name is exempt.`;

const SOURCES =
  "Pass exactly one source: `script` (a one-off script written inline; it is saved to a draft file the result names — revise that file and resubmit with `path`, never paste the script again), `saved` (a workflow saved in this project or globally, by name; check ListSavedWorkflows before writing one from scratch), or `path` (a script file on disk, normally the file a previous result named). To change a run that already exists — errored, completed, stopped or still running — call AmendWorkflow instead of starting over.";

export const CREATE_WORKFLOW_TOOL_DESCRIPTION = [
  INTRO,
  "",
  WHEN_TO_USE,
  "",
  SKILL_GATE,
  "",
  SOURCES,
].join("\n");
