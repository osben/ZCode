import {
  getZCodeAgentModeSelectOptions,
  type ModelSelection,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  type ModelProviderGroupLabelOptions,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveV4ModelTriggerLabel } from "@/v4/composer/modelTriggerDisplay.js";

// The scheduled-task form must remain a local draft; do not call the workspace-default-config write API to retrieve options,
// or merely opening or canceling the editor could change the current project's and draft session's runtime config.

/** Default permission mode: Ask before changes. */
export const AUTOMATION_DEFAULT_MODE = "build";

/** A new task must persist the target Host's preferredSelection as a concrete model, not save a virtual "default model." */
export function resolveAutomationPreferredModelValue(
  view: Pick<ModelSelectionView, "preferredSelection">,
): string | null {
  const preferred = view.preferredSelection;
  return preferred ? encodeCustomModelValue(preferred.providerId, preferred.modelId) : null;
}

export function buildAutomationModelSelectGroups(params: {
  selectedProvider: ZCodeProvider;
  labels: ModelProviderGroupLabelOptions;
  registrySelectionView: ModelSelectionView;
}): ModelSelectGroup[] {
  return buildRegistryModelSelectGroups(
    params.selectedProvider,
    params.registrySelectionView,
    params.labels,
  );
}

export function buildAutomationModeOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
    options: getZCodeAgentModeSelectOptions(),
  };
}

function findDirectModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  for (const group of modelGroups) {
    const item = group.items.find((candidate) => candidate.value === modelValue);
    if (item) return item;
  }
  return null;
}

export function resolveAutomationModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  const direct = findDirectModelItem(modelGroups, modelValue);
  if (direct) return direct;

  const separator = modelValue.indexOf("/");
  const qualifiedProviderId = separator > 0 ? modelValue.slice(0, separator) : null;
  const qualifiedModelId = separator > 0 ? modelValue.slice(separator + 1) : modelValue;
  const modelMatches = modelGroups.flatMap((group) =>
    group.items.filter((item) => {
      const decoded = decodeCustomModelValue(item.value);
      return decoded?.modelName === qualifiedModelId;
    }),
  );
  if (qualifiedProviderId) {
    const providerMatches = modelMatches.filter(
      (item) => decodeCustomModelValue(item.value)?.providerId === qualifiedProviderId,
    );
    if (providerMatches.length === 1) return providerMatches[0] ?? null;
  }
  // Historical automations may store only a model name; when providers share a name, do not guess its source.
  // Workspace runtime may also return wrapped values such as zcode-openai-compatible/model. If the provider does not match,
  // fill in the menu item only when the model name is globally unique, preserving the associated reasoning metadata for the default model.
  return modelMatches.length === 1 ? (modelMatches[0] ?? null) : null;
}

export function resolveAutomationModelTriggerLabel(params: {
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelValue: string;
  fallbackLabel: string;
}): string {
  const selectedItem = resolveAutomationModelItem(params.modelGroups, params.modelValue);
  if (!selectedItem) {
    const decodedModel = decodeCustomModelValue(params.modelValue);
    if (decodedModel?.modelName) {
      // Retain historical model names only for display; do not add them to current candidates or change save/dispatch behavior.
      return decodedModel.modelName;
    }

    const separator = params.modelValue.indexOf("/");
    return separator > 0
      ? params.modelValue.slice(separator + 1)
      : params.modelValue.trim() || params.fallbackLabel;
  }

  const selectedModel = decodeCustomModelValue(selectedItem.value);
  const providerId = selectedModel?.providerId;
  const providerName =
    params.modelSelectionView?.providers.find((provider) => provider.providerId === providerId)
      ?.providerName ?? undefined;

  // Automations used to truncate provider/model protocol values and show only the final model name,
  // making the same model's identity text inconsistent between conversations and scheduled tasks. Reuse the conversation-side rule here,
  // retaining the same truncation semantics for built-in families and invalid values.
  return resolveV4ModelTriggerLabel({
    modelGroups: params.modelGroups,
    normalizedValue: selectedItem.value,
    fallbackLabel: params.fallbackLabel,
    providerId,
    providerName,
  });
}

export function buildAutomationThoughtLevelOption(
  runtimeOption: ZCodeConfigOption | undefined,
  currentValue: string,
): ZCodeConfigOption | null {
  const options = runtimeOption?.options ?? [];
  if (options.length === 0) return null;
  const validCurrentValue = options.some((option) => option.value === currentValue);
  // Rationale: refreshing candidates is not a user choice; do not change an invalid level to the default/highest and save it.
  const resolvedValue = validCurrentValue ? currentValue : "";

  return {
    id: "thought_level",
    name: runtimeOption?.name ?? "Effort",
    category: "thought_level",
    type: "select",
    currentValue: resolvedValue,
    options: options.map((option) => ({ ...option })),
  };
}

/**
 * When updating an existing automation, use null to explicitly clear a stale value for a target model that does not support Think;
 * in the update protocol, undefined means “leave unchanged,” which would carry the source model’s level into the next dispatch.
 */
export function resolveAutomationThoughtLevelUpdate(params: {
  editing: boolean;
  explicitlyChanged: boolean;
  modelChanged: boolean;
  persistedReasoningLevel?: string;
  resolvedThoughtLevel: string;
  thoughtLevel: string;
}): string | null | undefined {
  if (params.resolvedThoughtLevel) {
    if (params.explicitlyChanged) return params.thoughtLevel;
    if (params.editing && !params.modelChanged) {
      return params.persistedReasoningLevel?.trim() || params.resolvedThoughtLevel;
    }
    return params.resolvedThoughtLevel;
  }
  return params.editing ? null : undefined;
}

/** Automation persists only the model choice; the execution chain determines the output budget for each request. */
export function buildAutomationModelSelection(params: {
  selected: ModelSelection;
  reasoningLevel?: string | null;
  previous?: ModelSelection;
}): ModelSelection {
  const reasoningLevel = params.reasoningLevel?.trim();
  const options = reasoningLevel ? { reasoningLevel } : {};
  return {
    providerId: params.selected.providerId,
    modelId: params.selected.modelId,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}
