// ============================================================
// Host implementation of ModelCatalogPort: the model catalog visible to the tool layer from Provider Registry.
// ============================================================
// See contracts/src/interfaces/model-catalog.port.ts for the port contract. This exists for one reason:
// `subagent_model` in `CreateWorkflow` / `AmendWorkflow` must resolve the user's model name into a subagent selection for a workflow run, but core cannot see the provider registry. This module passes along the host fact of which models exist; resolution stays in a pure core function.
//
// This and `listRegistryBackedModels` in provider-registry-selection.ts are **two views** of the same registry:
// that function produces the GUI picker's `ZCodeModelOption` (with label / maxOutputTokens / format properties); this one produces the narrower entries the tool layer needs. Deliberately do not share a projection function: the two views have independent field sets and presence rules, and combining them could let a picker change silently alter model-resolution criteria. They share only the **default reasoning-level rule** (see below).

import type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

interface ModelCatalogPortDeps {
  /** The process Provider Registry. Store the **whole object**; never call `getView()` here and keep a snapshot. */
  registry: ProviderRegistryModelSource;
  /**
   * The session's **current** model selection (`runtime.getSessionModelSelection()`). Like the registry, this is a function
   * rather than a value: `current` reflects each listing call, and the user may change the main model between tool calls.
   */
  currentSelection: () => ModelSelection | undefined;
}

/**
 * Create a {@link ModelCatalogPort}.
 *
 * **Read `registry.getView()` on every `listModels()` call**; never cache it. This is not a performance tradeoff; stale provider registry behavior taught us that a subagent can retain the provider adapter from when the parent session was created. If the user changes providers, the subagent may still send requests to a configuration that no longer exists. A catalog frozen at construction could make `subagent_model` select a model already removed, with the failure surfacing only when the subagent first makes a request—long after the user confirmed. The view is an in-memory object, so rereading it is not I/O.
 */
export function createModelCatalogPort(deps: ModelCatalogPortDeps): ModelCatalogPort {
  return {
    listModels(): ModelCatalogEntry[] {
      // This line implements the entire rule above. Any "optimization" that moves it outside the closure repeats the same problem.
      const view = deps.registry.getView();
      const current = deps.currentSelection();
      return view.providers.flatMap((provider) =>
        provider.models.map((model): ModelCatalogEntry => {
          const reasoning = model.config.optionSpecs.reasoningLevel;
          // **Copy** the reasoning-level list instead of returning it directly: registry values are part of a readonly view,
          // while the port contract provides a normal readable array, so callers receive a copy that cannot change with the registry.
          const reasoningLevels = [...reasoning.values];
          // The default level is the last level, following the **same rule** as provider-registry-selection.ts's `toModelOption`
          // (the GUI picker's `reasoning.defaultLevel`). Different defaults here could produce a discrepancy only the user would notice: the picker defaults to high while `subagent_model` defaults to low when no level is specified. Models without levels omit the entire field (empty array + no default).
          const defaultReasoningLevel = reasoning.default ?? reasoning.values.at(-1);
          const contextWindow = model.config.properties.contextWindow;
          // In the registry, `providerName` is `string | null | undefined` (config-service.ts normalizes empty strings to `null`), while the port contract uses `string | undefined`. Normalize all three "no name" cases to **one** answer: omit the key. Never pass through `null` or an empty string; it would be printed as-is in the ListModels row, while the reader expects to fall back to providerId if no name was set.
          const providerLabel = provider.providerName?.trim();
          return {
            providerId: provider.providerId,
            modelId: model.modelId,
            // The provider's human-readable name; omit it if unset (the reader falls back to providerId). Do not substitute
            // providerId here, or the port would lose the distinction between a set name and no name.
            ...(providerLabel ? { providerLabel } : {}),
            reasoningLevels,
            ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
            ...(contextWindow === undefined ? {} : { contextWindow }),
            // A match on both identity fields means the current selection; options are not part of identity (same criterion as pin comparison in workflow-actor-model.ts). At most one row in the whole list can be true.
            current:
              current !== undefined &&
              current.providerId === provider.providerId &&
              current.modelId === model.modelId,
            // `disabledReason` is deliberately **always absent**: this host has no source for that fact today. The GUI model list
            // uses the same registry (`listRegistryBackedModels → toModelOption`) and also never sets this field; `registry.validateSelection()` is not a source either, because every listed model comes from the registry view and therefore validates by construction. The only place in the repository that currently produces disabledReason is the desktop legacy config migration in packages/services, which cannot access this registry. If a "configured but unavailable" criterion is added in the future (missing key, policy disabled), it can be added here without changing the port contract.
          };
        }),
      );
    },
  };
}
