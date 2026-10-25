import {
  acpProviderId,
  describeForkAcpAgentLaunchProblem,
  forkAcpAgentRecordSchema,
  isAcpAgentAccess,
  type ForkAcpAgentStore,
  type PersonalProviderConfigRepository,
} from "@zcode/provider";
import type {
  AcpAgentEnabledInput,
  AcpAgentSaveInput,
  ProviderSettingsAcpAgentWriter,
} from "./acpAgentsContract.js";

/**
 * Writes ACP agent records to the fork-owned sidecar store only; `provider_config.json` is
 * shared with upstream builds and must never receive an `acp-agent` provider.
 */
export function createAcpAgentWriter(
  store: ForkAcpAgentStore,
  personalRepository: Pick<PersonalProviderConfigRepository, "read">,
): ProviderSettingsAcpAgentWriter {
  return {
    async save(input: AcpAgentSaveInput) {
      const record = forkAcpAgentRecordSchema.parse({
        agentId: input.agentId,
        providerName: input.providerName,
        enabled: input.enabled,
        command: input.command,
        args: [...input.args],
        env: { ...input.env },
      });
      const problem = describeForkAcpAgentLaunchProblem(record);
      if (problem) throw new Error(`Invalid ACP launch: ${problem}`);
      const providerId = acpProviderId(record.agentId);
      const existing = (await personalRepository.read()).providers.get(providerId);
      if (existing && !isAcpAgentAccess(existing.access)) {
        throw new Error(`Provider ID is already in use: ${providerId}`);
      }
      await store.update((current) => {
        const index = current.findIndex((agent) => agent.agentId === record.agentId);
        if (index === -1) return [...current, record];
        return current.map((agent, position) => (position === index ? record : agent));
      });
    },
    async setEnabled(input: AcpAgentEnabledInput) {
      await store.update((current) => {
        if (!current.some((agent) => agent.agentId === input.agentId)) {
          throw new Error(`Unknown ACP agent: ${input.agentId}`);
        }
        return current.map((agent) =>
          agent.agentId === input.agentId ? { ...agent, enabled: input.enabled } : agent,
        );
      });
    },
  };
}
