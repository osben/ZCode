/**
 * Turn reconcile of an ACP agent's session configuration (specs/acp-agent-runtime.md "S6: agent
 * configuration options").
 *
 * Before each prompt the driver re-applies the user's chosen values to the agent: a choice the agent
 * no longer offers is dropped, a choice that differs from the agent's current value is set, and the
 * offered snapshot is persisted (display copy) and emitted when it changed. The driver never writes
 * choices; the command handler owns them.
 */
import type { AcpConfigOption } from "@zcode/acp-agent-runtime";
import type { ForkAcpSessionBindingStore } from "@zcode/adapters/storage";
import {
  ExternalAgentTurnError,
  canonicalExternalAgentConfig,
  externalAgentConfigOffers,
  type ExternalAgentConfigOption,
  type Logger,
} from "@zcode/contracts";

/** Config part of the session binding store (fork_acp_session_binding). */
export type AcpSessionConfigStore = Pick<
  ForkAcpSessionBindingStore,
  "readConfig" | "writeOffered" | "writeChoice"
>;

/** The runtime surface the reconcile uses; `AcpSessionRuntime` satisfies it. */
export interface AcpConfigRuntime {
  readonly configOptions?: readonly AcpConfigOption[];
  setConfigOption?(configId: string, value: string): Promise<readonly AcpConfigOption[]>;
}

export interface AcpConfigReconcileInput {
  readonly runtime: AcpConfigRuntime;
  readonly store: AcpSessionConfigStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly logger?: Logger;
  /** Receives the offered snapshot when it differs from the stored display copy. */
  readonly onOptions: (options: readonly ExternalAgentConfigOption[]) => void;
}

/** The runtime snapshot in the turn contract's shape (field order fixed, groups already flat). */
export function toExternalAgentConfig(
  options: readonly AcpConfigOption[] | undefined,
): ExternalAgentConfigOption[] {
  return (options ?? []).map((option) => ({
    id: option.id,
    name: option.name,
    description: option.description ?? null,
    category: option.category ?? null,
    currentValue: option.currentValue,
    options: option.options.map((value) => ({
      value: value.value,
      name: value.name,
      description: value.description ?? null,
      group: value.group ?? null,
    })),
  }));
}

export async function reconcileAcpSessionConfig(input: AcpConfigReconcileInput): Promise<void> {
  const { runtime, store, sessionId, agentId, logger } = input;
  const stored = await store.readConfig(sessionId);
  for (const [configId, value] of Object.entries(stored.choices)) {
    const option = toExternalAgentConfig(runtime.configOptions).find((item) => item.id === configId);
    if (option === undefined || !externalAgentConfigOffers(option, value)) {
      // Values are never logged: a choice can name a model the user picked.
      logger?.debug("ACP agent config choice dropped", {
        event: "external_agent.config_dropped",
        module: "bootstrap.acp-agent",
        agentId,
        configId,
      });
      continue;
    }
    if (option.currentValue === value) continue;
    try {
      if (runtime.setConfigOption === undefined) {
        throw new Error("the agent runtime cannot change its configuration");
      }
      await runtime.setConfigOption(configId, value);
    } catch (error) {
      const valueName = option.options.find((item) => item.value === value)?.name ?? value;
      throw new ExternalAgentTurnError(
        "prompt_failed",
        `Could not set ${option.name} to ${valueName}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const snapshot = toExternalAgentConfig(runtime.configOptions);
  // An agent without options and a session without a stored copy have nothing to show.
  if (stored.offered === undefined && snapshot.length === 0) return;
  if (
    stored.offered !== undefined &&
    canonicalExternalAgentConfig(stored.offered) === canonicalExternalAgentConfig(snapshot)
  ) {
    return;
  }
  await store.writeOffered(sessionId, snapshot);
  input.onOptions(snapshot);
}
