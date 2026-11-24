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
  SkillNotFoundError,
  type SkillContent,
  type SkillPort,
  type SkillRuntimeInput,
} from "@zcode/contracts";
import { levenshteinDistance } from "../levenshtein.js";
import type {
  DynamicWorkflowToolSurfaceDeferral,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputValidationResult,
} from "../types.js";

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

/** `skill` is empty after trimming whitespace. */
const SKILL_INVALID_FORMAT_CODE = 1;
/** Still not found after the catalog was re-read. */
const SKILL_UNKNOWN_CODE = 2;
/** Maximum edit distance for similar-name suggestions. */
const SKILL_SUGGESTION_MAX_DISTANCE = 2;

/**
 * Notice placed before `<skill_content>` when an onDemand session loads the `dynamic-workflows` skill before activation
 * (docs/dynamic-workflow/launch.md, "On demand: activation").
 *
 * Fix reason: under onDemand the skill is still in the listing (the `skills:` preload of `/workflow` must be able to read it), and when the user only says
 * in words "do X with a workflow" the model loads it; the body requires calling CreateWorkflow whenever a workflow is named, yet the ten workflow tools
 * are not registered before activation, so the model gets stuck or quietly switches to Agent, and the user does not know to send `/workflow`.
 *
 * Why it lives in the Skill result: only the call that actually loads this skill pays these tokens, and the tool declarations, system prompt and skill listing
 * of a session that never mentions workflows stay byte-identical. The `/workflow` command path cannot read it: the command's activation happens at expansion, before the
 * `skills:` preload, when the probe is already false. A request in words is still not an activation trigger; this only informs and does not activate.
 */
export const DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE =
  "Note: the workflow tools (CreateWorkflow and the others this skill names) were not enabled in this session at the moment this skill was loaded, so the instructions below cannot be followed yet. Do not try to call those tools, and do not stand in for a workflow with the Agent tool. Tell the user, in the user's language, to send a message that starts with `/workflow` to enable workflows in this session; the tools appear after that.";

/**
 * Notice for child runtimes (Agent subagents, workflow child sessions such as `/expert`). Fix reason (review CR-01): a child runtime's
 * tool surface is carried over from the parent config at creation, it has no `/workflow` entry, and a command the user sends in the parent session
 * will not make the tools appear in this already-started child session. The text above would be a recovery step that cannot be honored here, so the child is only told
 * "workflows cannot run here, report the limitation to the parent agent", and the parent session, which has the command entry, relays it to the user.
 */
export const DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE =
  "Note: the workflow tools (CreateWorkflow and the others this skill names) are not available in this child agent session and will not become available in it, so the instructions below cannot be followed here. Do not try to call those tools, and do not stand in for a workflow with the Agent tool. Report this limitation in your result to the parent agent: workflows can only be started from the main session, after the user sends a message there that starts with `/workflow`.";

/** Deferral form -> notice; `none` has no notice. */
const DEFERRED_NOTICE_BY_DEFERRAL: Record<DynamicWorkflowToolSurfaceDeferral, string> = {
  none: "",
  session: DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE,
  subagent: DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE,
};

/** The tool-level result budget is static, so use the largest body limit, plus the wrapper and the longer of the two deferral notices. */
const MAX_SKILL_RESULT_BYTES =
  WORKFLOW_SKILL_MAX_BYTES +
  SKILL_RESULT_WRAPPER_BYTES +
  Math.max(
    Buffer.byteLength(DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE, "utf8"),
    Buffer.byteLength(DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE, "utf8"),
  );

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

  let loaded: SkillContent;
  try {
    loaded = await skillPort.loadSkill(
      {
        name: skill,
        workingDirectory: context.workingDirectory,
        maxBytes: skillMaxBytes(skill),
        trace: skillTrace(context),
      },
      { signal: context.abortSignal },
    );
  } catch (error) {
    // 修复原因：找不到 skill 原来是不带 <tool_use_error> 的 `Skill not found: X`。它是可预期的输入错误，
    // 现在返回失败由 executor 包装，并给出目录里最相近的名称。只能在端口重读目录之后判定，所以在 handler 里转换。
    if (!(error instanceof SkillNotFoundError)) throw error;
    return unknownSkillFailure(skill, skillPort, context);
  }

  context.recordSkillTelemetryMetadata?.({
    name: loaded.metadata.name,
    ...(loaded.metadata.qualifiedName ? { qualifiedName: loaded.metadata.qualifiedName } : {}),
    ...(loaded.metadata.pluginId ? { pluginId: loaded.metadata.pluginId } : {}),
    source: loaded.metadata.source,
  });

  // 判据是请求里的名字，与字节上限、技能门认的是同一个；探针缺席时不加提示。
  const deferredNotice =
    skill === DYNAMIC_WORKFLOW_SKILL_NAME
      ? DEFERRED_NOTICE_BY_DEFERRAL[context.getDynamicWorkflowToolSurfaceDeferral?.() ?? "none"]
      : "";

  return [
    deferredNotice,
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

function skillTrace(context: ToolExecutionContext) {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  };
}

async function unknownSkillFailure(
  skill: string,
  skillPort: SkillPort,
  context: ToolExecutionContext,
): Promise<ToolHandlerFailure> {
  // 建议只是附加信息：读目录失败时只报找不到。
  const outcome = await skillPort
    .discoverSkills(
      { workingDirectory: context.workingDirectory, trace: skillTrace(context) },
      { signal: context.abortSignal },
    )
    .catch(() => undefined);
  // 候选按目录顺序：先显示名（插件 skill 是限定名），再是短名；距离相同取靠前的。
  const candidates = (outcome?.skills ?? []).flatMap((metadata) =>
    metadata.qualifiedName && metadata.qualifiedName !== metadata.name
      ? [metadata.qualifiedName, metadata.name]
      : [metadata.name],
  );
  let suggestion: string | undefined;
  let bestDistance = SKILL_SUGGESTION_MAX_DISTANCE + 1;
  for (const candidate of candidates) {
    // 目录里有同名项但端口仍找不到（读正文时文件刚被删除等）：不提示同一个名字。
    if (candidate === skill) continue;
    if (Math.abs(candidate.length - skill.length) > SKILL_SUGGESTION_MAX_DISTANCE) continue;
    const distance = levenshteinDistance(skill, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      suggestion = candidate;
    }
  }
  return {
    result: false,
    errorCode: SKILL_UNKNOWN_CODE,
    message: suggestion
      ? `Unknown skill: ${skill}. Did you mean ${suggestion}?`
      : `Unknown skill: ${skill}`,
  };
}

function validateSkillInput(input: unknown): ToolInputValidationResult {
  const skill = (input as { skill?: unknown } | undefined)?.skill;
  if (typeof skill === "string" && skill.trim() === "") {
    return {
      result: false,
      errorCode: SKILL_INVALID_FORMAT_CODE,
      message: `Invalid skill format: ${skill}`,
    };
  }
  return { result: true };
}

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
  validateInput: validateSkillInput,
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
