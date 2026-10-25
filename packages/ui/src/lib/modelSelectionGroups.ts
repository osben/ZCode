import {
  ZCODE_AGENT_PROVIDER,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
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
  // 仅剩 glm（ZCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
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
    // ACP agents have no HTTP api section by design; the registry's availability decides whether
    // they are listed at all (specs/acp-agent-runtime.md "Chat delegation (phase 4)").
    const isExternalAgent = provider.config.access?.type === "acp-agent";
    if (
      !isExternalAgent &&
      !supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)
    ) {
      return [];
    }

    const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const accountPresentation = accountAccess.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;

    // 合并菜单仍需区分同名供应商的接入方式；API 标识直接来自 access，不能从名称猜测。
    // Only the ChatGPT plan and the api.openai.com key get an access badge; other API-key providers stay unbadged.
    const labelBadge =
      accountPresentation?.labelBadge ??
      getAccessTypeGroupBadge(provider.config.access, provider.config.api?.baseUrl, labels);

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
        ...(provider.config.logo ? { logo: provider.config.logo } : {}),
        ...(labelBadge ? { labelBadge } : {}),
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
  access: { type: string } | null | undefined,
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
