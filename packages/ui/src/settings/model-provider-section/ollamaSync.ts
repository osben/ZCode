/**
 * Pure helpers for the Ollama entry of Model Settings (specs/ollama-local-provider.md): which detected models
 * can be used, and the idempotent plan that brings the `ollama` personal provider to the checked set.
 */
import type { ModelConfigObject, ProviderConfigObject } from "@zcode/provider";
import type { OllamaModelSummary } from "@zcode/services";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_PROVIDER_NAME = "Ollama";
/** Ollama ignores the Authorization header; the config schema needs a non-blank key. */
export const OLLAMA_PLACEHOLDER_API_KEY = "ollama";
export const OLLAMA_NAV_KEY = "local:ollama";

/** `ok`: chat with tools; `unknown`: the server reports no capabilities (older Ollama). */
export type OllamaModelEligibility = "ok" | "unknown" | "noTools" | "notChat";

export function ollamaModelEligibility(model: OllamaModelSummary): OllamaModelEligibility {
  if (!model.capabilities) return "unknown";
  if (!model.capabilities.includes("completion")) return "notChat";
  return model.capabilities.includes("tools") ? "ok" : "noTools";
}

export function isOllamaModelSelectable(model: OllamaModelSummary): boolean {
  const eligibility = ollamaModelEligibility(model);
  return eligibility === "ok" || eligibility === "unknown";
}

/** The OpenAI-compatible endpoint the provider stores for a server root. */
export function ollamaProviderBaseUrl(root: string): string {
  return `${root.replace(/\/+$/, "")}/v1`;
}

/** The server root of a stored provider endpoint (`<root>/v1`), or null when the provider has none. */
export function ollamaRootFromProvider(
  provider: ProviderSettingsFormProvider | null,
): string | null {
  const baseUrl = provider?.config.api?.baseUrl?.trim();
  if (!baseUrl) return null;
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function ollamaProviderInitialConfig(root: string): ProviderConfigObject {
  return {
    access: { type: "api-key", apiKey: OLLAMA_PLACEHOLDER_API_KEY },
    api: { type: "openai-chat-completions", baseUrl: ollamaProviderBaseUrl(root) },
  };
}

export function ollamaModelConfig(model: OllamaModelSummary): ModelConfigObject {
  const vision = model.capabilities?.includes("vision") === true;
  return {
    properties: {
      // Unknown capabilities stay usable: the CLI refuses tool calls for a model marked without them.
      supportsToolCall: model.capabilities ? model.capabilities.includes("tools") : true,
      ...(model.contextLength ? { contextWindow: model.contextLength } : {}),
      ...(vision ? { inputFormat: { supportsText: true, supportsImage: true } } : {}),
    },
  };
}

/** Model ids currently in the provider. */
export function ollamaProviderModelIds(provider: ProviderSettingsFormProvider | null): string[] {
  return provider?.models.map((model) => model.modelId) ?? [];
}

export interface OllamaSyncPlan {
  readonly create: ProviderConfigObject | null;
  readonly add: readonly { readonly modelId: string; readonly config: ModelConfigObject }[];
  readonly remove: readonly string[];
}

/**
 * The steps from the provider's current models to the checked set. Only detected models are removed when
 * unchecked; a provider model the server no longer reports is kept. Running the plan again after a partial
 * failure yields only the remaining steps.
 */
export function planOllamaSync(input: {
  readonly provider: ProviderSettingsFormProvider | null;
  readonly root: string;
  readonly detected: readonly OllamaModelSummary[];
  readonly checked: ReadonlySet<string>;
}): OllamaSyncPlan {
  const present = new Set(ollamaProviderModelIds(input.provider));
  const detected = new Map(input.detected.map((model) => [model.name, model]));
  const add = [...input.checked].flatMap((name) => {
    const model = detected.get(name);
    return model && !present.has(name) && isOllamaModelSelectable(model)
      ? [{ modelId: name, config: ollamaModelConfig(model) }]
      : [];
  });
  const remove = [...present].filter((name) => detected.has(name) && !input.checked.has(name));
  return {
    create: input.provider ? null : ollamaProviderInitialConfig(input.root),
    add,
    remove,
  };
}

export function isOllamaSyncPlanEmpty(plan: OllamaSyncPlan): boolean {
  return plan.add.length === 0 && plan.remove.length === 0;
}
