/**
 * ACP agents as derived personal providers (specs/acp-agent-runtime.md "Storage and upstream
 * compatibility").
 *
 * The fork-owned sidecar store is the single owner of ACP agent records. `provider_config.json`
 * is shared with upstream builds whose strict schemas reject the `acp-agent` access, so the
 * `acp:<agentId>` provider and its synthetic model are derived on read and never written there.
 */
import { z } from "zod";
import { ACP_ENV_KEY_PATTERN } from "@zcode/shared/acp-launch-rules";
import {
  AcpAgentAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  isAcpAgentAccess,
  type ModelConfigObject,
  type ProviderConfigRule,
} from "./config/index.js";
import { completeAcpAgentAccessDataSchema } from "./config/provider-data-schema.js";
import type { ProviderConfigLayerUpdate } from "./config-service.js";
import type { ProviderConfigSnapshot, ProviderSource } from "./sources.js";

export const ACP_PROVIDER_ID_PREFIX = "acp:";

export function acpProviderId(agentId: string): string {
  return `${ACP_PROVIDER_ID_PREFIX}${agentId}`;
}

/**
 * One stored agent. The launch fields stay structural (like the sparse stored provider shape):
 * a record that violates the launch rules still loads and is reported by complete validation.
 */
export const forkAcpAgentRecordSchema = z
  .object({
    agentId: z.string().regex(/^\S+$/),
    providerName: z.string().min(1),
    enabled: z.boolean(),
    command: z.string(),
    args: z.array(z.string()).readonly(),
    env: z.record(z.string().regex(ACP_ENV_KEY_PATTERN), z.string()).readonly().optional(),
  })
  .strict();

export type ForkAcpAgentRecord = z.infer<typeof forkAcpAgentRecordSchema>;

export const forkAcpAgentsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(forkAcpAgentRecordSchema).readonly(),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    file.agents.forEach((agent, index) => {
      if (seen.has(agent.agentId)) {
        context.addIssue({
          code: "custom",
          path: ["agents", index, "agentId"],
          message: `Duplicate ACP agent id: ${agent.agentId}`,
        });
      }
      seen.add(agent.agentId);
    });
  });

export interface ForkAcpAgentSnapshot {
  readonly revision: string;
  readonly agents: readonly ForkAcpAgentRecord[];
}

/** Owner port of the sidecar; implemented by `NodeForkAcpAgentStore` in `@zcode/provider-node`. */
export interface ForkAcpAgentStore extends ProviderSource<ForkAcpAgentSnapshot> {
  update(
    transform: (current: readonly ForkAcpAgentRecord[]) => readonly ForkAcpAgentRecord[],
  ): Promise<ForkAcpAgentSnapshot>;
}

export function encodeForkAcpAgentsFile(agents: readonly ForkAcpAgentRecord[]) {
  return forkAcpAgentsFileSchema.parse({
    schemaVersion: 1,
    agents: agents.map((agent) => ({
      agentId: agent.agentId,
      providerName: agent.providerName,
      enabled: agent.enabled,
      command: agent.command,
      args: [...agent.args],
      ...(agent.env === undefined ? {} : { env: { ...agent.env } }),
    })),
  });
}

/** Launch-rule problems of a record, using the same complete schema as provider validation. */
export function describeForkAcpAgentLaunchProblem(record: ForkAcpAgentRecord): string | null {
  const result = completeAcpAgentAccessDataSchema.safeParse(acpAccessData(record));
  if (result.success) return null;
  return result.error.issues
    .map((issue) => `${issue.path.join(".") || "access"}: ${issue.message}`)
    .join("; ");
}

/**
 * Context windows: opencode reports 262144 via `usage_update`; cursor uses a placeholder until
 * real numbers are observed.
 */
const ACP_CONTEXT_WINDOW_BY_AGENT: Record<string, number> = {
  opencode: 262144,
  cursor: 200000,
};
const DEFAULT_ACP_CONTEXT_WINDOW = 200000;

/**
 * Complete synthetic model config for the ACP pseudo-model, mirroring the shape the provider
 * resolver expects (every system leaf present, a singular "auto" reasoning level and a no-op
 * option map).
 */
export function buildAcpPseudoModelConfig(agentId: string): ModelConfigObject {
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: ACP_CONTEXT_WINDOW_BY_AGENT[agentId] ?? DEFAULT_ACP_CONTEXT_WINDOW,
      inputFormat: {
        supportsText: true,
        // Both agents advertise promptCapabilities.image; v1 sends current-turn images as ACP blocks.
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["auto"], default: "auto", map: "{}" },
      maxOutputTokens: { max: 32000, map: "{}" },
    },
  };
}

function acpAccessData(record: ForkAcpAgentRecord) {
  return {
    type: "acp-agent" as const,
    agentId: record.agentId,
    command: record.command,
    args: record.args,
    ...(record.env === undefined ? {} : { env: record.env }),
  };
}

function derivedProviderRule(record: ForkAcpAgentRecord): ProviderConfigRule {
  const { type: _type, ...access } = acpAccessData(record);
  return {
    providerId: acpProviderId(record.agentId),
    providerName: record.providerName,
    enabled: record.enabled,
    config: new ProviderConfig({
      group: "standard-personal",
      access: new AcpAgentAccessConfig(access),
      personalModelIds: [record.agentId],
      modelOrder: [record.agentId],
    }),
  };
}

/**
 * Adds one personal provider per sidecar record. A same-id rule in `provider_config.json` wins
 * unless it is a legacy inline `acp-agent` rule, which the sidecar record replaces.
 */
export function deriveAcpAgentConfigSnapshot(
  snapshot: ProviderConfigSnapshot,
  acp: ForkAcpAgentSnapshot,
): ProviderConfigSnapshot {
  if (acp.agents.length === 0) return snapshot;
  const derived = new Map<string, ForkAcpAgentRecord>();
  for (const record of acp.agents) {
    const providerId = acpProviderId(record.agentId);
    const existing = snapshot.personalProviders.get(providerId);
    if (existing && !isAcpAgentAccess(existing.access)) continue;
    derived.set(providerId, record);
  }
  if (derived.size === 0) return snapshot;
  const providers = new ProviderConfigMap([
    ...snapshot.personalProviders.rules().filter((rule) => !derived.has(rule.providerId)),
    ...[...derived.values()].map(derivedProviderRule),
  ]);
  let models = snapshot.personalModels;
  for (const [providerId, record] of derived) {
    models = models.deleteExactForProvider(providerId);
    models = new ModelConfigRules([
      ...models.rules(),
      {
        type: "provider-model",
        providerId,
        modelId: record.agentId,
        config: ModelConfig.fromData(buildAcpPseudoModelConfig(record.agentId)),
      },
    ]);
  }
  return Object.freeze({
    ...snapshot,
    // Only the top-level revision changes: the registry deduplicates by it, while
    // `personalRevision` must keep matching the file for personal CAS writes.
    revision: `${snapshot.revision}#acp:${acp.revision}`,
    personalProviders: providers,
    personalModels: models,
  });
}

/** Wraps the registry config source so every read derives the ACP agent providers. */
export function createDerivedAcpAgentConfigSource(
  source: ProviderSource<ProviderConfigSnapshot>,
  store: ProviderSource<ForkAcpAgentSnapshot>,
): ProviderSource<ProviderConfigSnapshot> {
  return {
    async read() {
      const [snapshot, acp] = await Promise.all([source.read(), store.read()]);
      return deriveAcpAgentConfigSnapshot(snapshot, acp);
    },
    onDidChange(listener) {
      const disposeSource = source.onDidChange(listener);
      const disposeStore = store.onDidChange((reason) => listener(`acp-agents:${reason}`));
      return () => {
        disposeSource();
        disposeStore();
      };
    },
  };
}

/** Records for legacy inline `acp-agent` rules found in `provider_config.json` (migration input). */
export function extractInlineAcpAgentRecords(
  update: Pick<ProviderConfigLayerUpdate, "providers">,
): ForkAcpAgentRecord[] {
  return update.providers.rules().flatMap((rule) => {
    const access = rule.config.access;
    if (!isAcpAgentAccess(access) || !rule.providerId.startsWith(ACP_PROVIDER_ID_PREFIX)) {
      return [];
    }
    const agentId = rule.providerId.slice(ACP_PROVIDER_ID_PREFIX.length);
    const parsed = forkAcpAgentRecordSchema.safeParse({
      agentId,
      providerName: rule.providerName ?? `${agentId} (ACP)`,
      enabled: rule.enabled ?? true,
      command: access.command ?? "",
      args: access.args ?? [],
      ...(access.env ? { env: access.env } : {}),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** True when the update still carries a provider with the fork-only `acp-agent` access. */
export function hasInlineAcpProviders(update: Pick<ProviderConfigLayerUpdate, "providers">) {
  return update.providers.rules().some((rule) => isAcpAgentAccess(rule.config.access));
}

/**
 * Removes the inline `acp:<agentId>` providers whose agent the sidecar already holds, with their
 * exact model rules and `providerOrder` entries. Any other `acp-agent` rule is kept: stripping a
 * rule that was never copied would lose it.
 */
export function stripInlineAcpProviders(
  update: ProviderConfigLayerUpdate,
  sidecarAgentIds: ReadonlySet<string>,
): ProviderConfigLayerUpdate {
  const removed = new Set(
    update.providers
      .rules()
      .filter(
        (rule) =>
          isAcpAgentAccess(rule.config.access) &&
          rule.providerId.startsWith(ACP_PROVIDER_ID_PREFIX) &&
          sidecarAgentIds.has(rule.providerId.slice(ACP_PROVIDER_ID_PREFIX.length)),
      )
      .map((rule) => rule.providerId),
  );
  if (removed.size === 0) return update;
  let models = update.models;
  for (const providerId of removed) models = models.deleteExactForProvider(providerId);
  return Object.freeze({
    ...update,
    providers: new ProviderConfigMap(
      update.providers.rules().filter((rule) => !removed.has(rule.providerId)),
    ),
    models,
    ...(update.providerOrder === undefined
      ? {}
      : { providerOrder: update.providerOrder.filter((id) => !removed.has(id)) }),
  });
}
