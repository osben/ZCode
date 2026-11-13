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

/**
 * Spread after both Host hello capability literals so the renderer takes the older-agent routes. Empty for
 * both runtimes: zcode-rs reports every flag the Host claims (the incognito flags left this table when
 * zcode-rs implemented incognito sessions).
 */
export function forkAgentRuntimeHelloOverrides(
  _env: NodeJS.ProcessEnv = process.env,
): Record<string, never> {
  return {};
}

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

/** What the gate may read from the agent; read only for a command that needs it. */
interface ForkAgentRuntimeGateCapabilities {
  /** The agent runs `acp:<agentId>` selections (runtime capability `externalAgentTurns`). */
  externalAgentTurns(): Promise<boolean>;
}

function isExternalAgentCommand(envelope: CommandEnvelopeLike): boolean {
  const payload = (envelope.payload ?? {}) as {
    modelSelection?: unknown;
    provider?: unknown;
    config?: { modelSelection?: unknown; provider?: unknown };
    firstInput?: { modelSelection?: unknown };
  };
  return (
    envelope.type === "setExternalAgentConfigOption" ||
    isAcpSelection(payload.modelSelection) ||
    isAcpSelection(payload.config?.modelSelection) ||
    isAcpSelection(payload.firstInput?.modelSelection) ||
    // switchModelConfig and createSession config name the provider as a plain id.
    (envelope.type === "switchModelConfig" && isAcpProvider(payload.provider)) ||
    isAcpProvider(payload.config?.provider)
  );
}

/**
 * Fork features zcode-rs may lack (specs/fork-agent-runtime-selection.md rule 7). An ACP command reaches the Rust
 * agent only when it reports `externalAgentTurns` (macOS); otherwise zcode-rs would run the prompt against an
 * unknown provider, so the command is refused. A failed capability read refuses too.
 */
export async function forkAgentRuntimeCommandGateError(
  envelope: CommandEnvelopeLike,
  capabilities: ForkAgentRuntimeGateCapabilities,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!isForkRustAgentRuntime(env) || !isExternalAgentCommand(envelope)) return undefined;
  const supported = await capabilities.externalAgentTurns().catch(() => false);
  return supported ? undefined : FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED;
}
