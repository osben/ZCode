// ============================================================
// Skill Tool Handler
// ============================================================

import {
  CoreErrorType,
  SkillInputJsonSchema,
  SkillInputSchema,
  SkillOutputJsonSchema,
  SkillOutputSchema,
  createCoreError,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  type SkillRuntimeInput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/** Default byte limit for skill content; the adapter truncates excess bytes from the end. */
export const MAX_SKILL_BYTES = 100_000;

/**
 * Byte limit for the `dynamic-workflows` skill (docs/dynamic-workflow/authoring.md, “The skill”).
 * Raised on 2026-09-30: this skill had been capped at 100,000 since 09-22, forcing existing guidance to be removed for each new feature.
 * Match by the requested name, the same value checked by the skill gate (workflow-skill-gate.ts).
 */
export const WORKFLOW_SKILL_MAX_BYTES = 200_000;

/** Headroom for the result wrapper (`<skill_content>` tag, title, Base directory line); the tool-level budget must accommodate it. */
export const SKILL_RESULT_WRAPPER_BYTES = 4_096;

/** The tool-level result budget is static, so use the largest body limit plus the wrapper. */
const MAX_SKILL_RESULT_BYTES = WORKFLOW_SKILL_MAX_BYTES + SKILL_RESULT_WRAPPER_BYTES;

function skillMaxBytes(skill: string): number {
  return skill === DYNAMIC_WORKFLOW_SKILL_NAME ? WORKFLOW_SKILL_MAX_BYTES : MAX_SKILL_BYTES;
}

export const skillHandler: ToolHandler = async (input, context) => {
  const { skill } = SkillInputSchema.parse(input) as SkillRuntimeInput;
  const skillPort = context.skillPort;

  if (!skillPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SkillPort is not configured for Skill tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Skill",
        },
        recoverable: false,
      },
    );
  }

  const loaded = await skillPort.loadSkill(
    {
      name: skill,
      workingDirectory: context.workingDirectory,
      maxBytes: skillMaxBytes(skill),
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      },
    },
    { signal: context.abortSignal },
  );

  context.recordSkillTelemetryMetadata?.({
    name: loaded.metadata.name,
    ...(loaded.metadata.qualifiedName ? { qualifiedName: loaded.metadata.qualifiedName } : {}),
    ...(loaded.metadata.pluginId ? { pluginId: loaded.metadata.pluginId } : {}),
    source: loaded.metadata.source,
  });

  return [
    `<skill_content name="${loaded.metadata.name}">`,
    `# Skill: ${loaded.metadata.name}`,
    "",
    expandSkillContextVariables(loaded.content, loaded.baseDirectory),
    "",
    `Base directory for this skill: ${loaded.baseDirectory}`,
    "Relative paths in this skill are relative to this base directory.",
    loaded.truncated ? "[Skill content truncated]" : "",
    "</skill_content>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

function expandSkillContextVariables(content: string, baseDirectory: string): string {
  // Only after the Skill tool loads do we know the current skill directory, so resolve variables here.
  return content.replace(/\$\{(CLAUDE_SKILL_DIR|ZCODE_SKILL_DIR)\}/gu, baseDirectory);
}

export const skillToolEntry: ToolEntry = {
  capability: "Load local skill instructions into the current session context",
  metadata: {
    name: "Skill",
    // The description lists only supported capabilities: no fork/background skills, no directory-scoped skill names.
    description: `Invoke a skill.

A skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a system-reminder listing with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach. Users may also ask for one by name (\`/<name>\`, or "slash command"); that's a request to invoke it.

- \`skill\`: exact name from the listing, no leading slash. Plugin skills use \`plugin:skill\`.
- \`args\`: optional arguments to pass through.

Only names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (\`/help\`, \`/clear\`, …) aren't skills. If a \`<command-name>\` block is already present this turn, the skill is loaded — follow it directly rather than calling again.
`,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_SKILL_RESULT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: skillHandler,
  inputSchema: SkillInputJsonSchema,
  outputSchema: SkillOutputJsonSchema,
  runtimeInputSchema: SkillInputSchema,
  runtimeOutputSchema: SkillOutputSchema,
  permission: {
    permission: "skill",
    reason: "Skill loads local instructions into session context",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SKILL_RESULT_BYTES,
    maxModelBytes: MAX_SKILL_RESULT_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SKILL_RESULT_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Skill loading was cancelled before content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
