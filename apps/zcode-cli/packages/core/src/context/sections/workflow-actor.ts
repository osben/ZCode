// ============================================================
// Workflow Actor Identity Section Builder
// ============================================================
//
// Identity section for a dynamic workflow subagent (workflow child).
//
// It replaces the interactive Agent Identity ("You are an interactive ZCode agent that helps users"): a subagent's reader is a script, not a person.
// It does **not** replace other base sections; the safety IMPORTANT lines and `# Harness` block are reused verbatim from identity,
// while the builder continues to append memory / skills / project instructions.
// The author-written persona follows the opening sentence and precedes the contract: role-specific instructions are more prominent than general rules,
// but the opening sentence first fixes who the agent is and who receives its output, which the persona cannot override.
//
// The contract previously varied by persona tool tier. In production, a GLM subagent with no tools was told to
// "Ground every claim in something you read or ran," prompting it to inspect directories and run commands it could not access;
// it then emitted a degraded `escalate("placeholder")`. The fix is to **state the tool surface explicitly**: first tell the subagent what it has,
// then explain where evidence comes from. Tool tiers have been removed, so every subagent has the full work toolset and one shared contract;
// the rule to state the tool surface explicitly remains.

import type { ContextSection, WorkflowActorContext } from "../types.js";
import { estimateTokens } from "../utils.js";
import {
  buildHarnessBlock,
  buildSecurityNotice,
  type IdentitySectionOptions,
} from "./identity.js";
import { DEFAULT_CONFIRMATION_PARAGRAPH } from "@zcode/shared";

/** Describe the tool surface with one sentence about what is available and one about what is not, so the model does not have to guess. */
const TOOL_SURFACE =
  "You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.";

/** Evidence standard: cite what was read/run, or supplied material when the ask includes it; only work actually run counts, at the scope requested. */
const EVIDENCE_RULE =
  // "Only what ran counts" addresses honesty, not scope; in production, subagents substituted one test file or one build for an entire requested suite.
  // Add a sentence to define scope.
  "Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if you executed it here; if you could not run it, report it as not run. Run the check an ask names rather than a faster substitute, and say exactly which command you ran.";

function buildWorkflowContract(): string {
  return [
    "# Working inside a workflow",
    `- ${TOOL_SURFACE}`,
    "- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.",
    `- ${EVIDENCE_RULE}`,
    "- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.",
    "- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run's owner knows — call `escalate`. Questions written in prose reach nobody.",
    // The artifact clause gives files written by a subagent a supported path out instead of discouraging them and leaving them untracked.
    // Subagents still have no artifact tools (only scripts can publish, so the trust boundary is unchanged), but
    // when the ask names an output path, write there and return the path so the script can publish it to the user.
    "- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.",
  ].join("\n");
}

/** `harness` toggle; off omits the `# Harness` block and keeps the confirmation floor. */
export type WorkflowActorSectionOptions = Pick<IdentitySectionOptions, "includeHarness">;

function buildWorkflowActorIdentityPrompt(
  actor: WorkflowActorContext,
  options: WorkflowActorSectionOptions,
): string {
  const name = actor.name?.trim();
  const named = name ? `, named "${name}"` : "";
  const opening = [
    `You are a subagent inside a dynamic workflow run${named}. A script created you and hands you work one ask at a time; the script — not a person — consumes what you return. There is no user in this conversation to talk to.`,
  ];
  const persona = actor.persona?.trim();
  // There is no longer a CLI prefix before this section ("You are ZCode, an interactive coding agent" is the wrong identity for a subagent),
  // so this is the first line of the system prompt and no longer starts with a blank line.
  const parts = [
    opening.join("\n"),
    ...(persona ? ["", persona] : []),
    "",
    buildSecurityNotice(),
    "",
    options.includeHarness ? buildHarnessBlock() : DEFAULT_CONFIRMATION_PARAGRAPH,
    "",
    buildWorkflowContract(),
  ];
  return parts.join("\n");
}

export function buildWorkflowActorIdentitySection(
  actor: WorkflowActorContext,
  options: WorkflowActorSectionOptions = { includeHarness: true },
): ContextSection {
  const content = buildWorkflowActorIdentityPrompt(actor, options);
  return {
    name: "Workflow Actor Identity",
    source: "workflow_actor_identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
