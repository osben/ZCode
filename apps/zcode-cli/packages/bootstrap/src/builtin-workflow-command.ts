import { expandCustomCommandPrompt, type CustomCommandContent } from "@zcode/contracts";
import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "@zcode/shared";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./app/bundled-skills.js";

/**
 * Built-in `/workflow` command (see "The `/workflow` command and the skill" in docs/dynamic-workflow/authoring.md).
 *
 * It used to be `commands/workflow.md` in the zcode-guide built-in plugin: the moment that plugin was uninstalled or disabled,
 * the command and its plus-menu entry disappeared while the ten workflow tools remained (2026-09-19 incident). The command body is now compiled
 * with the CLI; like `/init`, it is a prompt-style built-in command defined in code, and its name is on the reserved list so same-named
 * user or plugin commands are no longer expanded.
 *
 * The body deliberately reuses contracts' custom-command expansion ($ARGUMENTS replacement + `skills:` preamble),
 * keeping the prompt the model sees byte-identical to the plugin era, with no re-tuning.
 */
export const BUILTIN_WORKFLOW_COMMAND_NAME = "workflow";

const helpEntry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
  (entry) => entry.name === BUILTIN_WORKFLOW_COMMAND_NAME,
);
if (!helpEntry) {
  // The shared help table is the sole source for reserved names, TUI candidates, and the App catalog; without an entry, the command is not addressable.
  throw new Error(`Missing builtin slash command help entry: ${BUILTIN_WORKFLOW_COMMAND_NAME}`);
}

const USAGE_PREFIX = `/${BUILTIN_WORKFLOW_COMMAND_NAME} `;
export const BUILTIN_WORKFLOW_COMMAND_DESCRIPTION = helpEntry.summary;
export const BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT = helpEntry.usage.startsWith(USAGE_PREFIX)
  ? helpEntry.usage.slice(USAGE_PREFIX.length)
  : "";

/** `$ARGUMENTS` must be present; otherwise expansion appends arguments as an uncontrolled "User arguments:" tail block. */
const BUILTIN_WORKFLOW_COMMAND_BODY = [
  `Use the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill to design and launch a dynamic workflow for this request:`,
  "",
  "$ARGUMENTS",
  "",
  "Decide the subagent topology before writing any code: how many subagents, which of them",
  "share a context, what result each one returns. Then write the script and call the",
  "`CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool. Do not use the",
  "legacy `Workflow` tool, and do not substitute the `Agent` tool.)",
  "",
].join("\n");

export const BUILTIN_WORKFLOW_COMMAND: CustomCommandContent = {
  bytesRead: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  content: BUILTIN_WORKFLOW_COMMAND_BODY,
  metadata: {
    allowedTools: [],
    argumentHint: BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT,
    description: BUILTIN_WORKFLOW_COMMAND_DESCRIPTION,
    disableNonInteractive: false,
    frontmatterKeys: ["description", "argument-hint", "skills"],
    name: BUILTIN_WORKFLOW_COMMAND_NAME,
    path: `builtin:${BUILTIN_WORKFLOW_COMMAND_NAME}`,
    rootPath: "builtin:",
    scope: "system",
    skills: [DYNAMIC_WORKFLOW_SKILL_NAME],
    source: "zcode",
  },
  sizeBytes: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  truncated: false,
};

export function expandBuiltinWorkflowCommandPrompt(args: string): string {
  return expandCustomCommandPrompt({ args, command: BUILTIN_WORKFLOW_COMMAND }).prompt;
}
