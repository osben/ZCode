import {
  DEFAULT_COMMUNICATION_PROMPT,
  DEFAULT_CONTEXT_MANAGEMENT_PROMPT,
} from "@zcode/shared";
import { TOTAL_TOKENS_SYSTEM_LINE } from "./total-tokens.js";
import type { ContextSection } from "./types.js";
import { estimateTokens } from "./utils.js";

// The default prompt's finishing and memory-saving sections are not split by model; they are sent even without a Memory directory, and the section states when its saving rules apply.
const FINISHING_WORK_PROMPT =
  "# Finishing work\nEnding your turn means your work stops there until asked to continue, and you should not stop unless needed. Please avoid stopping while work the user asked for is still owed. Status notes are welcome, and so are your recommendations on open decisions, but do not stop unnecessarily and carry on with whatever does not depend on the user's answer. If you notice yourself inviting the user to redirect you or offering to wait, instead proceed on the next part of the task. You may meet ordinary obstacles like errors, timeouts, locked files, empty results or failing tools. Diagnose them first, and when they are not real blockers, work through them with the access you have (wait and retry, fix the request, use another tool or source) rather than stopping or checking in. If someone clearly decided something is a hard blocker, such as a file marked not to be touched, access that was intentionally withheld, or a safety guardrail, leave it alone, say plainly what you found, and look for another way to finish the task. Stopping before the task is complete can rarely be merited, i.e. when the task can't move forward without user input, or where the blocker is deliberate and should not be worked past. This does not override the need for confirmation on risky or destructive actions.";

const MEMORY_NOTES_PROMPT = [
  "# Memory, notes and feedback",
  "This adds to the Memory section and takes precedence over it. The rules about saving apply only if this session has a directory for saving memories.",
  "",
  "Save only what is applicable and durable:",
  "applicable: it would directly change your behavior in future sessions, such as an approach the user corrected or steered you away from, or a standing preference they expressed. Not ambient code context or state.",
  "durable: it applies to multiple future sessions and tasks, not just this one. Not transient task plans or status. If you are uncertain whether something is durable, assume it is not and do not save it.",
  "",
  "Avoid saving an unnecessary record of completed work (commits, merges, review outcomes, status summaries). Pointers to external resources and environment facts the user would otherwise have to restate are still worth saving.",
  "",
  "Don't overindex on soft feedback - give it the appropriate weight based on the context, and if you can't tell whether it's an instruction or just a comment, ask once but carry on. When saving feedback, record the specifics (what, who, when, why, scope) and label your own interpretations as yours.",
  "",
  "Same for your notes - if they contain some caution or limitation, question whether the reason still holds and drop it if not. This isn't a reason to take risky, irreversible, destructive actions without confirmation though, and an old or general go-ahead doesn't count as confirmation, so if the caution is about these kinds of actions then keep it until a human gives confirmation (even if you wrote it yourself).",
  "",
  "Don't create planning, decision, or analysis documents unless the user asks for them \u2014 work from the context, not intermediate files.",
].join("\n");

export function buildSessionGuidanceSection(
  toolNames: readonly string[],
  hasSkills = false,
): ContextSection | null {
  const tools = new Set(toolNames);
  const lines = ["# Session-specific guidance"];
  // 插件发现工具已改为 deferred，暂不注入插件推荐指导段。
  // if (tools.has("SearchPlugins") && tools.has("SuggestPluginInstall")) {
  //   lines.push(
  //     "- Check existing capabilities first. When an official plugin would materially help the user's task, proactively use SearchPlugins, then SuggestPluginInstall with a concrete reason. Do not invent plugins or repeat skipped suggestions. The confirmation card owns installation approval. Installed plugins are usable only after activation is ready.",
  //   );
  // }

  // Do not emit the Agent guidance section for now.
  // if (tools.has("Agent")) {
  //   lines.push("- Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.");

  //   let exploreGuide = "- For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore.";
  //   const fallbackSearch = getDirectSearchGuidance(tools);
  //   if (fallbackSearch) {
  //     exploreGuide += ` Otherwise use ${fallbackSearch} directly.`;
  //   }
  //   lines.push(exploreGuide);
  // }

  if (tools.has("Skill") && hasSkills) {
    lines.push(
      " - When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section \u2014 don't guess.",
    );
  }

  // if (tools.has("AskUserQuestion")) {
  //   lines.push("- Use AskUserQuestion when you need a bounded clarification before proceeding.");
  // }

  if (lines.length <= 1) {
    return null;
  }

  // Emit this section only when session guidance has content, avoiding an empty heading in the simple branch.
  return createDynamicSection("Session-specific guidance", "session_guidance", lines.join("\n"));
}

export function buildDynamicBehaviorSection(override?: string): ContextSection {
  // A `communication` override (docs/system-prompt-overrides.md) replaces the whole section
  // body — guidance paragraphs, code-style rule, and risk paragraph together.
  const content = override?.trim() ? override.trim() : DEFAULT_COMMUNICATION_PROMPT;
  return createDynamicSection("Dynamic Behavior", "dynamic_behavior", content);
}

export function buildContextManagementSection(override?: string): ContextSection {
  // A `context-management` override replaces the whole section body, autonomy appendix included.
  const content = override?.trim() ? override.trim() : DEFAULT_CONTEXT_MANAGEMENT_PROMPT;
  return createDynamicSection("Context Management", "context_management", content);
}

export function buildFinishingWorkSection(): ContextSection {
  return createDynamicSection("Finishing Work", "finishing_work", FINISHING_WORK_PROMPT);
}

export function buildMemoryNotesSection(): ContextSection {
  return createDynamicSection("Memory Notes", "memory_notes", MEMORY_NOTES_PROMPT);
}

/** 固定的 token 预算行，是 system 的最后一段；倒数由每次请求的提醒附件表达。开关关闭时不产出。 */
export function buildTotalTokensSection(enabled: boolean): ContextSection | null {
  if (!enabled) return null;
  return createDynamicSection("Total Tokens", "total_tokens", TOTAL_TOKENS_SYSTEM_LINE);
}

function createDynamicSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
