import {
  DEFAULT_COMMUNICATION_PROMPT,
  DEFAULT_CONTEXT_MANAGEMENT_PROMPT,
} from "@zcode/shared";
import { TOTAL_TOKENS_SYSTEM_LINE } from "./total-tokens.js";
import type { ContextSection } from "./types.js";
import { estimateTokens } from "./utils.js";

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

/** 固定的 token 预算行，是 system 的最后一段；倒数由每次请求的提醒附件表达。 */
export function buildTotalTokensSection(): ContextSection {
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
