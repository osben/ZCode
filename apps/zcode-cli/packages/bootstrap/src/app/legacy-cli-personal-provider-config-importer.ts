import { readFile } from "node:fs/promises";
import { BUILTIN_PROVIDER_TEMPLATE_IDS } from "@zcode/shared";
import { getDefaultConfigPath } from "@zcode/adapters/config";
import {
  parseLegacyCliModelConfig,
  type LegacyCliModelConfigProjection,
} from "./legacy-cli-model-config.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderApiType,
  type ProviderConfigLayerUpdate,
  type ModelSelection,
} from "@zcode/provider";

interface LegacyCliPersonalProviderConfigImportInput {
  readonly input: unknown;
}

const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

class UnsupportedLegacyCliProviderConfigError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`旧 CLI Provider ${providerId} 含有正式 Config 尚不能表达的执行字段`);
    this.name = "UnsupportedLegacyCliProviderConfigError";
    this.providerId = providerId;
  }
}

function resolveLegacyProviderApiType(
  kind: "anthropic" | "openai" | "openai-compatible" | undefined,
): ProviderApiType {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
    case undefined:
      return "openai-chat-completions";
  }
  return "openai-chat-completions";
}

/** Migrate explicit Provider definitions from the legacy CLI user file to the new Personal Overlay. */
function importLegacyCliPersonalProviderConfig(
  input: LegacyCliPersonalProviderConfigImportInput,
): ProviderConfigLayerUpdate {
  const runtimePatch = parseLegacyCliModelConfig(input.input);
  // The generic ZCodeConfigFileSchema intentionally leaves legacy providers in passthrough unknown,
  // so reading their types from that result prevents the Bootstrap build from verifying the
  // model/provider structure. Consume only the validated projection from the dedicated legacy
  // format parser here, keeping compatibility logic within the read boundary.
  let providers = ProviderConfigMap.empty();
  let models = ModelConfigRules.empty();

  for (const [rawProviderId, provider] of Object.entries(runtimePatch.provider ?? {})) {
    const providerId = rawProviderId.trim();
    if (!providerId) continue;
    // Standalone also reads builtin:* / source=custom values written by the legacy Desktop app.
    // Match Desktop import behavior: do not migrate legacy built-in static configuration or account
    // credentials; retain only the Key for metered APIs.
    const templateId =
      providerId === "builtin:bigmodel"
        ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
        : providerId === "builtin:zai"
          ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
          : undefined;
    if (templateId) {
      const apiKey = provider.options?.apiKey?.trim();
      if (apiKey)
        providers = providers.setRule({
          providerId: templateId,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey }),
          }),
        });
      continue;
    }
    if (providerId.startsWith("builtin:") || providerId.startsWith("account:")) continue;
    if (provider.source !== undefined && provider.source !== "custom") continue;
    if (requiresUnsupportedNoAuthentication(provider)) {
      throw new UnsupportedLegacyCliProviderConfigError(providerId);
    }
    const members = collectLegacyCliModelMembers(provider);
    const modelIds = members.map((member) => member.modelId);
    const providerName = provider.name?.trim();
    providers = providers.setRule({
      providerId,
      providerName: providerName && providerName !== providerId ? providerName : undefined,
      config: new ProviderConfig({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({
          apiKey: provider.options?.apiKey,
        }),
        api: new ProviderApiConfig({
          type: resolveLegacyProviderApiType(provider.kind),
          baseUrl: provider.options?.baseURL,
          headers: mergeHeaders(provider.headers, provider.options?.headers),
        }),
        ...(modelIds.length > 0 ? { personalModelIds: modelIds, modelOrder: modelIds } : {}),
      }),
    });
    for (const member of members) {
      if (member.contextWindow === undefined) continue;
      models = models.setExact(
        providerId,
        member.modelId,
        new ModelConfig({
          properties: new ModelPropertiesConfig({ contextWindow: member.contextWindow }),
        }),
      );
    }
  }

  // The default selection and Provider are derived from the same legacy-file read and imported only
  // when the Personal file is first created. Clearing the default later must not read the legacy
  // main again, and creating a partial config first must not block migration of the remaining fields.
  const defaultModelSelection = importLegacyCliConfiguredDefault(input.input) ?? undefined;
  return Object.freeze({ providers, models, defaultModelSelection });
}

export async function readLegacyCliPersonalProviderConfig(input: {
  readonly filePath?: string;
}): Promise<ProviderConfigLayerUpdate | null> {
  const filePath = input.filePath ?? getDefaultConfigPath();
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return importLegacyCliPersonalProviderConfig({ input: raw });
  } catch (error) {
    if (isFileNotFound(error)) return null;
    // Migration must be all or nothing. While the formal Config cannot represent legacy execution
    // fields, keep the legacy path and do not write a partial Personal file that would block a future migration.
    if (error instanceof UnsupportedLegacyCliProviderConfigError) return null;
    throw error;
  }
}

/** Migrate only the main model in the legacy CLI user file as the Environment default selection. */
function importLegacyCliConfiguredDefault(input: unknown): ModelSelection | null {
  const main = parseLegacyCliModelConfig(input).model?.main;
  if (!main || main.provider === RETIRED_ZAPI_PROVIDER_ID) return null;
  return Object.freeze({
    providerId: main.provider,
    modelId: main.model,
  });
}

type LegacyCliProvider = NonNullable<LegacyCliModelConfigProjection["provider"]>[string];

interface LegacyCliModelMember {
  readonly modelId: string;
  readonly contextWindow?: number;
}

function collectLegacyCliModelMembers(
  provider: LegacyCliProvider,
): readonly LegacyCliModelMember[] {
  const seen = new Set<string>();
  const members: LegacyCliModelMember[] = [];
  for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
    if (model.deleted === true) continue;
    const modelId = (model.id ?? modelKey).trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const contextWindow = model.contextWindow ?? model.limit?.context;
    members.push({
      modelId,
      ...(isPositiveInteger(contextWindow) ? { contextWindow } : {}),
    });
  }
  return members;
}

function mergeHeaders(
  ...values: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const result = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(result).length > 0 ? result : undefined;
}

function requiresUnsupportedNoAuthentication(provider: LegacyCliProvider): boolean {
  return provider.options?.apiKeyRequired === false;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
