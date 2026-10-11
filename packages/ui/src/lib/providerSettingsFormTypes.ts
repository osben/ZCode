import { isApiKeyAccess } from "@zcode/provider";
import type {
  ConfigValidationIssue,
  AccountProviderState,
  ModelConfigObject,
  ProviderConfigObject,
  ProviderSettingsProviderView,
} from "@zcode/provider";

/** Provider state used by the settings page during one edit session. */
export interface ProviderSettingsFormProvider extends Pick<
  ProviderSettingsProviderView,
  "providerName" | "templateId"
> {
  providerId: string;
  /** Patch for an explicit rename in this edit only; other edits must not materialize an inherited name as personal configuration. */
  providerNameUpdate?: string | null;
  /** Patch for explicit top-level enable/disable in this edit only; ordinary field edits must not copy inherited enabled state. */
  enabledUpdate?: boolean;
  enabled: boolean;
  /** State derived by Registry from current Official, Personal, and Account Facts. */
  executable: boolean;
  accountState?: AccountProviderState;
  issues?: readonly ConfigValidationIssue[];
  hasPersonalConfig: boolean;
  /** Renderer modifies and submits only this sparse Personal Overlay. */
  personalConfig: ProviderConfigObject;
  /** Read-only inherited baseline and current form display values; not persisted directly. */
  config: ProviderConfigObject;
  models: ProviderSettingsFormModel[];
}

/** Model state used by the settings page during one edit session. */
export interface ProviderSettingsFormModel {
  kind: "candidate";
  modelId: string;
  builtin: boolean;
  /** Resolved Built-in Rule before the Personal Rule overlay, used by the editor to represent inheritance and sparse overrides. */
  inheritedConfig?: ModelConfigObject;
  personalConfig: ModelConfigObject;
  /** Missing or true means follow the Built-in recommendation; false means use fixed personal configuration. */
  useRecommendedConfig?: boolean;
  config: ModelConfigObject;
  hasPersonalConfig: boolean;
  executable: boolean;
  selectable: boolean;
  issues?: readonly ConfigValidationIssue[];
}

export function getProviderFormLabel(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "providerName">,
): string {
  return provider.providerName?.trim() || provider.providerId;
}

export function getProviderFormApiKey(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string {
  return isApiKeyAccess(provider.config.access) ? (provider.config.access.apiKey ?? "") : "";
}

export function getProviderFormApiKeyManagementUrl(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string | undefined {
  return isApiKeyAccess(provider.config.access)
    ? (provider.config.access.apiKeyManagementUrl ?? undefined)
    : undefined;
}
