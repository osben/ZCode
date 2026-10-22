// ============================================================
// External agent session configuration (specs/acp-agent-runtime.md "S6: agent configuration options")
// ============================================================
// The selects an ACP agent offers for its session (mode, model, effort, ...). Core and the session
// store see them only in this shape; the driver maps the runtime snapshot onto it, so nothing outside
// bootstrap imports the ACP runtime. Absent agent fields are `null`, never `undefined`, so the shape
// survives a JSON round-trip unchanged.

/** One value of a select option. `group` is the agent's group label; groups are flat here. */
export interface ExternalAgentConfigValue {
  readonly value: string;
  readonly name: string;
  readonly description: string | null;
  readonly group: string | null;
}

/** One select option the agent offers, with its current value. */
export interface ExternalAgentConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly currentValue: string;
  readonly options: readonly ExternalAgentConfigValue[];
}

/** Payload of `external_agent_config_updated`: the options the composer shows for the session. */
export interface ExternalAgentConfigUpdatedPayload {
  readonly agentId: string;
  readonly options: readonly ExternalAgentConfigOption[];
}

/**
 * Payload of `external_agent_status`: the agent produced no frame for `silentMs` (`stalled`) or sent
 * one again (`resumed`). A transient turn status, never a transcript row.
 */
export interface ExternalAgentStatusPayload {
  readonly agentId: string;
  readonly status: "stalled" | "resumed";
  readonly silentMs?: number;
}

/** Whether `value` is one of the values `option` offers (groups are already flat). */
export function externalAgentConfigOffers(option: ExternalAgentConfigOption, value: string): boolean {
  return option.options.some((candidate) => candidate.value === value);
}

/**
 * Canonical JSON of an option list: fixed field order, so two snapshots of the same options compare
 * equal whatever key order their source used.
 */
export function canonicalExternalAgentConfig(options: readonly ExternalAgentConfigOption[]): string {
  return JSON.stringify(
    options.map((option) => ({
      id: option.id,
      name: option.name,
      description: option.description,
      category: option.category,
      currentValue: option.currentValue,
      options: option.options.map((value) => ({
        value: value.value,
        name: value.name,
        description: value.description,
        group: value.group,
      })),
    })),
  );
}
