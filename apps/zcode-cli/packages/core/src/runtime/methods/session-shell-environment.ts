import { countContextPrefixMessages } from "../deps.js";
import type { ExecutionShellSelection } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

type SessionShellConfig = Pick<AgentRuntimeConfig, "bashShellSelection">;

export type SessionShellEnvironmentCandidate =
  | ExecutionShellSelection
  | (() => ExecutionShellSelection);

export interface SessionShellEnvironment {
  selection: ExecutionShellSelection;
  promptShell: string;
}

export function getSessionShellSelectionFromConfig(
  config: SessionShellConfig,
): ExecutionShellSelection | undefined {
  return config.bashShellSelection;
}

export function getSessionShellEnvironment(
  runtime: AgentRuntimeInternal,
): SessionShellEnvironment | undefined {
  const selection = getSessionShellSelectionFromConfig(runtime.config);
  if (!selection) return undefined;
  return {
    promptShell: selection.display.name,
    selection,
  };
}

export function getSessionShellSelection(
  runtime: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return getSessionShellEnvironment(runtime)?.selection;
}

export function getContextSourceShellDisplayName(
  runtime: AgentRuntimeInternal,
): string | undefined {
  return getSessionShellEnvironment(runtime)?.promptShell;
}

export function initializeSessionShellEnvironmentIfNeeded(
  runtime: AgentRuntimeInternal,
  candidate: SessionShellEnvironmentCandidate,
): boolean {
  if (getSessionShellEnvironment(runtime)) {
    return false;
  }

  // Bash shell 在 runtime 第一次用户执行或冷恢复前初始化一次，之后不热更新；
  // 新 runtime 都读取当前设置，变化由环境公告告诉模型。所有入口都只表达“当前候选值”，
  // candidate 可以是 lazy resolver，已初始化的 runtime 不会在外层重复探测 shell。
  const selection = resolveSessionShellCandidate(candidate);
  runtime.config.bashShellSelection = selection;
  refreshBranchAwareBuiltInTools(runtime);
  refreshPreConversationShellContext(runtime, selection);
  return true;
}

function resolveSessionShellCandidate(
  candidate: SessionShellEnvironmentCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}

export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T,
  selection: ExecutionShellSelection | undefined,
): T;
export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined;
export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined {
  if (!envInfo || !selection?.display.name) {
    return envInfo;
  }
  return {
    ...envInfo,
    shell: selection.display.name,
  };
}

function refreshPreConversationShellContext(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
): void {
  if (
    !selection ||
    !runtime.contextBuilder ||
    !runtime.contextInitialized ||
    !runtime.contextSourceSnapshot ||
    runtime.sessionPersisted
  ) {
    return;
  }
  const activeEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  if (activeEntries.length !== countContextPrefixMessages(activeEntries)) {
    return;
  }

  // A deferred draft is a hidden prewarm state with no real conversation message before the first send.
  // When refreshing the shell then, also refresh session-start # Environment so the Shell shown to the model matches the shell Bash actually executes.
  runtime.config.envInfo = applySessionShellToEnvInfo(runtime.config.envInfo, selection);
  runtime.contextSourceSnapshot = {
    ...runtime.contextSourceSnapshot,
    envInfo: applySessionShellToEnvInfo(runtime.contextSourceSnapshot.envInfo, selection),
  };
  rebuildContextPrefix(runtime);
}
