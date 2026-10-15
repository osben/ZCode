import {
  ZCODE_AGENT_PROVIDER,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { ProviderConfigObject } from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { isChatGptPlanSubscriptionProviderId } from "@/lib/chatgptPlanProvider.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  chatgptPlanBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

function supportsRegistryApiFormat(
  selectedProvider: string,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // Only the glm (ZCode Agent) provider remains; third-party CLI api-format differences became irrelevant when those providers were removed.
  // The ChatGPT plan runs through the same bundled agent (SIWC wiring in the CLI), so its
  // sessions must keep the registry picker; otherwise selecting a gpt model collapses the
  // menu to "Manage models" with no way back.
  return (
    selectedProvider === ZCODE_AGENT_PROVIDER ||
    isChatGptPlanSubscriptionProviderId(selectedProvider)
  );
}

export function buildRegistryModelSelectGroups(
  selectedProvider: string,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
): ModelSelectGroup[] {
  return view.providers.flatMap((provider) => {
    if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

    const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const accountPresentation = accountAccess.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;
    // Visual distinction inside the picker: the ChatGPT plan is subscription-backed while the
    // api.openai.com API-key provider uses a personal key — both share the OpenAI models.
    const accessTypeBadge = getAccessTypeGroupBadge(
      provider.config.access,
      provider.config.api?.baseUrl,
      labels,
    );

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
        ...(accountPresentation?.labelBadge
          ? { labelBadge: accountPresentation.labelBadge }
          : accessTypeBadge
            ? { labelBadge: accessTypeBadge }
            : {}),
        ...(accountPresentation ? { directItems: true } : {}),
        items: provider.models.map(({ modelId, config }) => ({
          key: `registry-provider:${provider.providerId}:${modelId}`,
          value: encodeCustomModelValue(provider.providerId, modelId),
          name: modelId,
          ...(shouldShowModelVisionBadge(
            modelId,
            config.properties?.inputFormat?.supportsImage,
            provider.config.access,
          )
            ? { supportsVisionInput: true }
            : {}),
        })),
      },
    ];
  });
}

function getAccessTypeGroupBadge(
  access: ProviderConfigObject["access"],
  baseUrl: string | null | undefined,
  labels: ModelProviderGroupLabelOptions,
): string | undefined {
  if (access?.type === "chatgpt-account") {
    return labels.chatgptPlanBadgeLabel ?? "Subscription";
  }
  if (access?.type === "api-key" && isApiOpenAiBaseUrl(baseUrl)) {
    return labels.apiKeyBadgeLabel ?? "API";
  }
  return undefined;
}

function isApiOpenAiBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
  } catch {
    return false;
  }
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: ZCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
