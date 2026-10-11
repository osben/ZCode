import {
  validateModelSelectionOptions,
  type ModelSelection,
  type ProviderRegistryView,
} from "./registry.js";

export type InitialModelSelectionResolution =
  | {
      readonly source: "configured-default" | "registry-fallback";
      readonly selection: ModelSelection;
    }
  | { readonly source: "none" };

interface ModelSelectionCompletionView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: {
          readonly reasoningLevel: { readonly values: readonly string[] };
        };
      };
    }[];
  }[];
}

export function resolveInitialModelSelection(input: {
  readonly configuredDefault?: ModelSelection;
  readonly registry: ProviderRegistryView;
}): InitialModelSelectionResolution {
  // This constructs only the Host's initial recommendation; it does not resolve intent from an existing session. An invalid default is a disposable preference,
  // so keep recommending in Registry order; do not apply the rule for clearing historical selections to new-draft initialization.
  if (input.configuredDefault) {
    if (isSelectable(input.registry, input.configuredDefault)) {
      return {
        source: "configured-default",
        selection: freezeSelection(input.configuredDefault),
      };
    }
  }

  // Only for the Host's initial recommendation in a new draft; an unbound historical state must not enter this initialization branch.
  for (const provider of input.registry.providers) {
    if (provider.config.visibility === "hidden") continue;
    for (const model of provider.models) {
      const selection = completeNewModelSelection(input.registry, {
        providerId: provider.providerId,
        modelId: model.modelId,
      });
      if (selection) return { source: "registry-fallback", selection: freezeSelection(selection) };
    }
  }
  return { source: "none" };
}

/** Build the highest level only when the user explicitly selects a model or during fresh initialization; do not use for restoring/re-resolving an existing selection. */
export function completeNewModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values.at(-1);
  if (!reasoningLevel) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel },
  };
}

/**
 * Normalize a Selection before submission.
 * If an existing selection is missing or invalid, keep only the model identity and wait for the user to choose a level; explicit model selection uses completion separately.
 * Every execution entry point must verify the Selection is complete afterward and must not silently fill in a level.
 */
export function normalizeModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return undefined;
  const values = model.config.optionSpecs.reasoningLevel.values;
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel !== undefined && values.includes(reasoningLevel)) return selection;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
  };
}

function isSelectable(registry: ProviderRegistryView, selection: ModelSelection): boolean {
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (provider?.config.visibility === "hidden") return false;
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return false;
  return validateModelSelectionOptions(model, selection).ok;
}

function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}
