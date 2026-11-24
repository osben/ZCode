import type { ModelToolContract } from "../deps.js";
import { registerBuiltInTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeAgentAlwaysBackground,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
  resolveRuntimeLspToolIncluded,
} from "../helpers/tool-allowlist.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";

export function resolveRuntimeEmbeddedSearchEnabled(runtime: AgentRuntimeInternal): boolean {
  const builtInToolAllowlist = resolveBuiltInToolAllowlist(runtime.config);
  const decision = resolveEmbeddedSearchBranchCapability({
    // bashAvailable 的含义是「Bash 最终会被注册」，所以要和注册时用同一份 resolved 名单。
    // 现在的结构性禁用里没有 Bash，这里的结果不变；用同一个 helper 是为了以后名单变化时两边不漂移。
    bashAvailable:
      (builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash")) &&
      !isToolNameDisallowed("Bash", resolveRuntimeDisallowedTools(runtime.config)),
  });
  return decision.useEmbeddedSearchBranch;
}

export function refreshBranchAwareBuiltInTools(runtime: AgentRuntimeInternal): void {
  const embeddedSearchEnabled = resolveRuntimeEmbeddedSearchEnabled(runtime);
  if (embeddedSearchEnabled) {
    runtime.registry.unregister("Glob");
    runtime.registry.unregister("Grep");
  }

  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    embeddedSearchEnabled,
    // This is the **second**
    // registration entry point and deliberately passes only a small set of options. Omitting gates that register only when true (OffPeak / Cron / Workflow…)
    // is safe, but the dynamic-workflow rollout gate has the opposite polarity: absence means enabled. Omitting it would add back all ten tools
    // removed during initial setup when the shell snapshot initializes (registry.register overwrites same-name entries,
    // and silentDuplicateWarnings hides the warning, so it is silent). Derivation must therefore share the helper in runtime-tools.ts
    // instead of reimplementing the condition here.
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    // Same helper as the initial registration in runtime-tools.ts; a refresh must not drop the LSP tool.
    includeLsp: resolveRuntimeLspToolIncluded(runtime),
    // The Agent background switch is also "absent means on"; omitting it would swap an Agent whose switch is off back to the always-background form on refresh.
    agentAlwaysBackground: resolveRuntimeAgentAlwaysBackground(runtime.config),
    // 会话工具同名两种实现，刷新必须沿用首次装配选定的运行位置，不能回落到另一种。
    sessionControlKind: runtime.sessionControlKind,
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // 与灰度门同理：结构性禁用（按 taskType 推导）必须和首次装配共用 resolveRuntimeDisallowedTools。
    // 曾经这里只传了用户配置的 toolDisallowlist，于是 shell 初始化或按需激活之后，子 runtime 在
    // 会话中途把首次装配剃掉的工作流工具加了回来（Z-011）。
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
    silentDuplicateWarnings: true,
  });
  runtime.invalidateToolCache();
}

export function filterEmbeddedSearchRuntimeVisibleTools(
  runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  if (!resolveRuntimeEmbeddedSearchEnabled(runtime)) return tools;
  return tools.filter((tool) => tool.name !== "Glob" && tool.name !== "Grep");
}
