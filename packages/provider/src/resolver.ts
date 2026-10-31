/* oxlint-disable eslint(max-lines) -- Resolver produces both layered Settings results and the sole proof of a complete Registry type. */
import type { z } from "zod";
import type { completeModelConfigDataSchema } from "@zcode/shared/model-config";
import type {
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
  completeChatgptAccountAccessDataSchema,
  completeProviderConfigDataSchema,
} from "./config/provider-data-schema.js";
import type { ConfigValidationIssue } from "./config-overlay.js";
import { completeAcpProviderConfigDataSchema } from "./config/provider-data-schema.js";
import { validateConfigSchema } from "./config/schema-validation.js";
import {
  type ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  isAcpAgentAccess,
  type ZhipuAccountAccessConfig,
  type ChatgptAccountAccessConfig,
  type ModelId,
  ProviderConfig,
  type ProviderConfigRule,
  ProviderConfigMap,
  type ProviderConfigObject,
  type ProviderTemplateMap,
  type ProviderId,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type { AccountProviderStates } from "./account-provider-state.js";

export type RegistryZhipuAccountAccessConfig = ZhipuAccountAccessConfig &
  z.infer<typeof completeZhipuAccountAccessDataSchema>;

export type RegistryChatgptAccountAccessConfig = ChatgptAccountAccessConfig &
  z.infer<typeof completeChatgptAccountAccessDataSchema>;

export type RegistryProviderAccessConfig =
  | (ApiKeyAccessConfig & z.infer<typeof completeApiKeyAccessDataSchema>)
  | RegistryZhipuAccountAccessConfig
  | RegistryChatgptAccountAccessConfig;

export type RegistryProviderConfig = ProviderConfig &
  z.infer<typeof completeProviderConfigDataSchema> & {
    readonly access: RegistryProviderAccessConfig;
  };

export type RegistryProviderConfigObject = z.infer<typeof completeProviderConfigDataSchema>;

export function serializeRegistryProviderConfig(
  config: RegistryProviderConfig,
): ProviderConfigObject {
  // ACP agents are validated by the ACP schema, not the API-key union. Only composer-facing facts are
  // projected: `env` is left out because it may carry credentials.
  if (isRegistryAcpAgentProvider(config)) {
    const access = config.access as unknown as {
      readonly agentId: string;
      readonly command: string;
      readonly args: readonly string[];
    };
    return {
      group: config.group,
      access: {
        type: "acp-agent",
        agentId: access.agentId,
        command: access.command,
        args: [...access.args],
      },
      ...(config.personalModelIds == null
        ? {}
        : { personalModelIds: [...config.personalModelIds] }),
      ...(config.modelOrder == null ? {} : { modelOrder: [...config.modelOrder] }),
      ...(config.visibility === undefined ? {} : { visibility: config.visibility }),
    };
  }
  return {
    group: config.group,
    ...(config.logo === undefined ? {} : { logo: config.logo }),
    access: serializeRegistryProviderAccess(config),
    api: {
      type: config.api.type,
      baseUrl: config.api.baseUrl,
      ...(config.api.headers == null ? {} : { headers: config.api.headers }),
    },
    ...(config.builtinModelIds == null ? {} : { builtinModelIds: [...config.builtinModelIds] }),
    ...(config.personalModelIds == null ? {} : { personalModelIds: [...config.personalModelIds] }),
    ...(config.modelOrder == null ? {} : { modelOrder: [...config.modelOrder] }),
    ...(config.visibility === undefined ? {} : { visibility: config.visibility }),
  };
}

function isRegistryAcpAgentProvider(config: RegistryProviderConfig): boolean {
  // The registry access union omits `acp-agent` on purpose (see provider-data-schema.ts).
  return (config.access as { readonly type?: unknown }).type === "acp-agent";
}

function serializeRegistryProviderAccess(
  config: RegistryProviderConfig,
): RegistryProviderConfigObject["access"] {
  switch (config.access.type) {
    case "zhipu-account":
      return {
        type: config.access.type,
        accountType: config.access.accountType,
        mode: config.access.mode,
        entitled: config.access.entitled,
      };
    case "chatgpt-account":
      return {
        type: config.access.type,
        entitled: config.access.entitled,
      };
    default:
      return {
        type: config.access.type,
        apiKey: config.access.apiKey,
        ...(config.access.apiKeyManagementUrl === undefined
          ? {}
          : { apiKeyManagementUrl: config.access.apiKeyManagementUrl }),
      };
  }
}

export type RegistryModelConfig = ModelConfig & z.infer<typeof completeModelConfigDataSchema>;

export type RegistryModelConfigObject = z.infer<typeof completeModelConfigDataSchema>;

export function serializeRegistryModelConfig(
  config: RegistryModelConfig,
): RegistryModelConfigObject {
  return {
    enabled: config.enabled,
    properties: {
      requiresMfjsToolSchema: config.properties.requiresMfjsToolSchema,
      contextWindow: config.properties.contextWindow,
      inputFormat: {
        supportsText: config.properties.inputFormat.supportsText,
        supportsImage: config.properties.inputFormat.supportsImage,
        supportsVideo: config.properties.inputFormat.supportsVideo,
        supportsAudio: config.properties.inputFormat.supportsAudio,
        supportsPdf: config.properties.inputFormat.supportsPdf,
      },
      outputFormat: { supportsText: config.properties.outputFormat.supportsText },
      supportsToolCall: config.properties.supportsToolCall,
      supportsJsonSchemaOutput: config.properties.supportsJsonSchemaOutput,
      supportsNativeWebSearch: config.properties.supportsNativeWebSearch,
      supportsMidConversationSystem: config.properties.supportsMidConversationSystem,
    },
    optionSpecs: {
      reasoningLevel: config.optionSpecs.reasoningLevel,
      maxOutputTokens: config.optionSpecs.maxOutputTokens,
    },
  };
}

export type RegistryConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly issues: readonly ConfigValidationIssue[] };

export function createRegistryProviderConfig(
  config: ProviderConfig,
  path: readonly string[] = ["provider"],
): RegistryConfigResult<RegistryProviderConfig> {
  const issues = config.validateComplete(path);
  return issues.length > 0
    ? { ok: false, issues: Object.freeze([...issues]) }
    : { ok: true, config: config as RegistryProviderConfig };
}

export function createRegistryModelConfig(
  config: ModelConfig,
  path: readonly string[] = ["model"],
): RegistryConfigResult<RegistryModelConfig> {
  const issues = config.validateComplete(path);
  return issues.length > 0
    ? { ok: false, issues: Object.freeze([...issues]) }
    : { ok: true, config: config as RegistryModelConfig };
}

export interface ProviderConfigResolverInput {
  readonly zcodeBuiltinProviders: ProviderConfigMap;
  readonly zcodeBuiltinProviderTemplates?: ProviderTemplateMap;
  readonly personalProviders: ProviderConfigMap;
  readonly zcodeBuiltinModelRules: ModelConfigRules;
  readonly personalModels: ModelConfigRules;
  readonly accountProviders: ProviderConfigMap;
  readonly accountStates?: AccountProviderStates;
  readonly personalProviderOrder?: readonly ProviderId[];
  /**
   * Availability gate for ACP agent models (specs/acp-agent-runtime.md "Availability (platform rule)").
   * False keeps `acp:<agentId>` models non-executable: they never reach the chat registry.
   */
  readonly acpExecutable?: boolean;
}

export interface ResolvedProviderModelCandidate {
  readonly kind: "candidate";
  readonly modelId: ModelId;
  readonly source: "builtin" | "personal";
  readonly config: ModelConfig;
  readonly effectiveBuiltinConfig: ModelConfig;
  readonly issues: readonly ConfigValidationIssue[];
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly selectable: boolean;
}

export type ResolvedProviderModel = ResolvedProviderModelCandidate;

export interface ResolvedProvider extends Pick<ProviderConfigRule, "templateId" | "providerName"> {
  readonly enabled: boolean;
  readonly providerId: ProviderId;
  readonly config: ProviderConfig;
  readonly templateConfig?: ProviderConfig;
  readonly effectiveBuiltinConfig?: ProviderConfig;
  readonly providerIssues: readonly ConfigValidationIssue[];
  readonly models: readonly ResolvedProviderModel[];
}

export interface ProviderModel {
  readonly modelId: ModelId;
  readonly config: RegistryModelConfig;
}

export interface Provider extends Pick<ProviderConfigRule, "templateId" | "providerName"> {
  readonly providerId: ProviderId;
  readonly config: RegistryProviderConfig;
  readonly models: readonly ProviderModel[];
}

export interface ProviderConfigResolution {
  readonly effectiveBuiltinProviders: ProviderConfigMap;
  readonly effectiveProviders: ProviderConfigMap;
  readonly resolvedProviders: readonly ResolvedProvider[];
  readonly registryProviders: readonly Provider[];
  readonly issues: readonly ConfigValidationIssue[];
}

export class ProviderConfigResolver {
  resolve(input: ProviderConfigResolverInput): ProviderConfigResolution {
    const accountProviders = new ProviderConfigMap(
      input.accountProviders
        .entries()
        .filter(([providerId]) => input.zcodeBuiltinProviders.has(providerId))
        .map(([providerId, config]) => [providerId, config.withoutGroup()] as const),
    );
    const concreteBuiltinProviders = input.zcodeBuiltinProviders.overlay(accountProviders);
    const providerTemplates = input.zcodeBuiltinProviderTemplates;
    const effectiveBuiltinProviders = concreteBuiltinProviders.mapConfigs((concrete, _id, rule) => {
      const template = rule.templateId
        ? providerTemplates?.get(rule.templateId)?.config
        : undefined;
      return template ? template.overlay(concrete) : concrete;
    });
    const personalProviders = input.personalProviders.mapConfigs((config, providerId) =>
      effectiveBuiltinProviders.has(providerId) ? config.withoutGroup() : config,
    );
    const templatePersonalProviders = personalProviders.mapConfigs((personal, providerId, rule) => {
      if (effectiveBuiltinProviders.has(providerId)) return personal;
      const template = rule.templateId
        ? providerTemplates?.get(rule.templateId)?.config
        : undefined;
      return template ? template.overlay(personal) : personal;
    });
    // Legacy model-config migrations may keep only the API URL with no templateId.
    // Fill in display material only, not the whole template, to avoid changing the
    // user's model membership, auth, or request behavior.
    const templateLogos = new Map<string, ProviderConfig["logo"]>();
    for (const [, template] of providerTemplates?.entries() ?? []) {
      const { api, logo } = template.config;
      if (!api?.type || !api.baseUrl || !logo) continue;
      const key = `${api.type}:${api.baseUrl.replace(/\/+$/, "")}`;
      if (templateLogos.has(key) && templateLogos.get(key)?.key !== logo.key) {
        templateLogos.set(key, undefined);
      } else if (!templateLogos.has(key)) {
        templateLogos.set(key, logo);
      }
    }
    const effectiveProviders = effectiveBuiltinProviders
      .overlay(templatePersonalProviders)
      .mapConfigs((config) => {
        if (config.logo !== undefined || !config.api?.type || !config.api.baseUrl) return config;
        const logo = templateLogos.get(
          `${config.api.type}:${config.api.baseUrl.replace(/\/+$/, "")}`,
        );
        return logo ? config.overlay(new ProviderConfig({ logo })) : config;
      });
    const effectiveModelRules = ModelConfigRules.composeEffective(
      input.zcodeBuiltinModelRules,
      input.personalModels,
    );
    const issues: ConfigValidationIssue[] = [];
    const resolvedProviders: ResolvedProvider[] = [];
    const registryProviders: Provider[] = [];

    for (const providerId of resolveProviderOrder(input, effectiveProviders)) {
      const rule = effectiveProviders.getRule(providerId)!;
      const { config, providerName } = rule;
      // Accounts no longer support global disable; an old overlay must not permanently disable an account with no toggle, while other eligibility checks still apply.
      const enabled =
        config.access?.type === "zhipu-account" ||
        config.access?.type === "chatgpt-account" ||
        (rule.enabled ?? true);
      const providerPath = ["providers", providerId];
      // ACP providers have no HTTP endpoint; validate them against the same
      // complete schema minus `api` (provider-level fields such as `group` are
      // checked too) and keep them out of the execution Registry until the
      // agent execution path lands — a registered-but-unroutable provider would
      // be selectable in chat and fail on send.
      const acpAccess = isAcpAgentAccess(config.access) ? config.access : null;
      // An ACP provider enters the execution Registry only when ACP is available; its complete
      // validity is the ACP schema (providerIssues below), so a valid config is admitted as-is.
      const registryProviderResult = acpAccess
        ? input.acpExecutable === true
          ? {
              ok: true as const,
              config: config as unknown as RegistryProviderConfig,
            }
          : null
        : createRegistryProviderConfig(config, providerPath);
      const providerIssues: ConfigValidationIssue[] = acpAccess
        ? [
            ...validateConfigSchema(
              completeAcpProviderConfigDataSchema,
              config.toJSON(),
              providerPath,
            ),
          ]
        : registryProviderResult!.ok
          ? []
          : [...registryProviderResult!.issues];
      const templateId = rule.templateId ?? undefined;
      const templateConfig = templateId ? providerTemplates?.get(templateId)?.config : undefined;
      if (templateId && !templateConfig) {
        providerIssues.push({
          code: "missing-template",
          path: [...providerPath, "templateId"],
          message: `Provider Template 不存在: ${templateId}`,
        });
      }
      issues.push(...providerIssues);
      const builtinModelIds = config.builtinModelIds ?? [];
      const personalModelIds = config.personalModelIds ?? [];
      const builtinIdsInOrder = uniqueInOrder(builtinModelIds);
      const builtinIds = new Set(builtinIdsInOrder);
      const personalIdsInOrder = uniqueInOrder(personalModelIds).filter(
        (modelId) => !builtinIds.has(modelId),
      );
      const orderedModelIds = resolveOwnedOrder(
        builtinIdsInOrder,
        personalIdsInOrder,
        config.modelOrder ?? [],
      );
      const accessEntitled =
        (config.access?.type !== "zhipu-account" && config.access?.type !== "chatgpt-account") ||
        config.access.entitled === true;
      // Account entitlement and the current connection are separate facts. Keep non-current accounts visible in Settings, but do not publish their models to the regular Registry.
      // Off-Peak does not define current and keeps its independent scheduling, visibility, and authentication rules.
      const accountCurrent = input.accountStates?.[providerId]?.current !== false;
      const providerExecutable =
        enabled && accessEntitled && accountCurrent && providerIssues.length === 0;
      const models = orderedModelIds.map((modelId): ResolvedProviderModel => {
        const modelConfig = effectiveModelRules.resolve({
          providerId,
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        });
        const effectiveBuiltinConfig = input.zcodeBuiltinModelRules.resolve({
          providerId,
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        });
        const registryModelResult = createRegistryModelConfig(modelConfig, [
          ...providerPath,
          "models",
          modelId,
        ]);
        const modelIssues = registryModelResult.ok ? [] : registryModelResult.issues;
        issues.push(...modelIssues);
        const modelEnabled = modelConfig.enabled === true;
        // ACP models stay non-executable when ACP is unavailable (acpExecutable); Settings must not
        // advertise a selectable model that cannot run in a packaged build.
        const executable =
          providerExecutable &&
          modelEnabled &&
          modelIssues.length === 0 &&
          (acpAccess === null || input.acpExecutable === true);
        const selectable = executable && config.visibility !== "hidden";
        return Object.freeze({
          kind: "candidate",
          modelId,
          source: builtinIds.has(modelId) ? "builtin" : "personal",
          config: modelConfig,
          effectiveBuiltinConfig,
          issues: Object.freeze(modelIssues),
          enabled: modelEnabled,
          executable,
          selectable,
        });
      });

      const resolvedProvider = Object.freeze({
        providerId,
        enabled,
        providerName,
        templateId,
        config,
        ...(templateConfig ? { templateConfig } : {}),
        ...(effectiveBuiltinProviders.get(providerId)
          ? { effectiveBuiltinConfig: effectiveBuiltinProviders.get(providerId) }
          : {}),
        providerIssues: Object.freeze([...providerIssues]),
        models: Object.freeze(models),
      });
      resolvedProviders.push(resolvedProvider);

      if (!registryProviderResult || !registryProviderResult.ok || providerIssues.length > 0) {
        continue;
      }
      const validModels = models
        .filter((model) => model.executable)
        .map(({ modelId, config: modelConfig }) => {
          const result = createRegistryModelConfig(modelConfig, [
            ...providerPath,
            "models",
            modelId,
          ]);
          if (!result.ok)
            throw new Error(`Registry Model 完整性结果不一致: ${providerId}/${modelId}`);
          return Object.freeze({ modelId, config: result.config });
        });
      if (validModels.length === 0) continue;
      registryProviders.push(
        Object.freeze({
          providerId,
          providerName,
          templateId,
          config: registryProviderResult.config,
          models: Object.freeze(validModels),
        }),
      );
    }

    return Object.freeze({
      effectiveBuiltinProviders,
      effectiveProviders,
      resolvedProviders: Object.freeze(resolvedProviders),
      registryProviders: Object.freeze(registryProviders),
      issues: Object.freeze(issues),
    });
  }
}

function uniqueInOrder(modelIds: readonly ModelId[]): readonly ModelId[] {
  const seen = new Set<ModelId>();
  return modelIds.filter((modelId) => {
    if (seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
}

function resolveProviderOrder(
  input: ProviderConfigResolverInput,
  effectiveProviders: ProviderConfigMap,
): readonly ProviderId[] {
  const sourceIds = effectiveProviders.keys();
  const familyIds = sourceIds.filter((providerId) => {
    const group = effectiveProviders.get(providerId)?.group;
    return group === "zai-family" || group === "bigmodel-family";
  });
  const familySet = new Set(familyIds);
  const builtinIds = input.zcodeBuiltinProviders
    .keys()
    .filter((providerId) => !familySet.has(providerId));
  const builtinSet = new Set(builtinIds);
  const personalIds = input.personalProviders
    .keys()
    .filter((providerId) => !builtinSet.has(providerId) && !familySet.has(providerId));
  return [
    ...familyIds,
    ...resolveOwnedOrder(builtinIds, personalIds, input.personalProviderOrder ?? []),
  ];
}
