import { FORK_AGENT_RUNTIME_ENV } from "@zcode/shared";

/**
 * What the Host may claim and admit while the frozen runtime is the Rust agent
 * (specs/fork-agent-runtime-selection.md, "Fork features in Rust mode").
 *
 * The table is static per runtime and only ever errs on the safe side: a flag is turned off here
 * because zcode-rs does not implement it, and is removed from this table once it does. The Host's
 * own capability gates (ensure*Support) stay in force behind it.
 */

export function isForkRustAgentRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FORK_AGENT_RUNTIME_ENV]?.trim() === "rust";
}

/** Spread after both Host hello capability literals so the renderer takes the older-agent routes. */
export function forkAgentRuntimeHelloOverrides(env: NodeJS.ProcessEnv = process.env): {
  incognitoSession?: false;
  incognitoPromptToggles?: false;
  independentPlanState?: false;
} {
  if (!isForkRustAgentRuntime(env)) return {};
  return {
    incognitoSession: false,
    incognitoPromptToggles: false,
    independentPlanState: false,
  };
}

export const FORK_RUST_AGENT_EXECUTION_WORKTREE_UNSUPPORTED =
  "proto.forkRustAgent.executionWorktreeUnsupported";
export const FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED =
  "proto.forkRustAgent.externalAgentUnsupported";

interface CommandEnvelopeLike {
  type: string;
  payload?: unknown;
}

function isAcpProvider(providerId: unknown): boolean {
  return typeof providerId === "string" && providerId.trim().startsWith("acp:");
}

function isAcpSelection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return isAcpProvider((value as { providerId?: unknown }).providerId);
}

/**
 * Fork features with no agent capability flag. The Node agent implements them; zcode-rs drops the
 * fields, which would run a worktree session in the main checkout or send an ACP prompt to an
 * unknown provider. Refuse them before the command reaches the Rust agent.
 */
export function forkAgentRuntimeCommandGateError(
  envelope: CommandEnvelopeLike,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isForkRustAgentRuntime(env)) return undefined;
  const payload = (envelope.payload ?? {}) as {
    worktreePreparation?: unknown;
    executionWorktree?: unknown;
    modelSelection?: unknown;
    provider?: unknown;
    config?: { modelSelection?: unknown; provider?: unknown };
    firstInput?: { modelSelection?: unknown };
  };
  if (
    envelope.type === "updateWorktreePreparation" ||
    (envelope.type === "createSession" &&
      (payload.worktreePreparation !== undefined || payload.executionWorktree !== undefined))
  ) {
    return FORK_RUST_AGENT_EXECUTION_WORKTREE_UNSUPPORTED;
  }
  if (
    envelope.type === "setExternalAgentConfigOption" ||
    isAcpSelection(payload.modelSelection) ||
    isAcpSelection(payload.config?.modelSelection) ||
    isAcpSelection(payload.firstInput?.modelSelection) ||
    // switchModelConfig and createSession config name the provider as a plain id.
    (envelope.type === "switchModelConfig" && isAcpProvider(payload.provider)) ||
    isAcpProvider(payload.config?.provider)
  ) {
    return FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED;
  }
  return undefined;
}
