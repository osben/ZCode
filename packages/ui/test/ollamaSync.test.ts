import { describe, expect, it } from "vitest";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  isOllamaSyncPlanEmpty,
  ollamaModelEligibility,
  ollamaRootFromProvider,
  planOllamaSync,
} from "@/settings/model-provider-section/ollamaSync.js";

// specs/ollama-local-provider.md "Sync" (OL4–OL6, OL8).
const ROOT = "http://127.0.0.1:11434";
const QWEN = { name: "qwen3", contextLength: 40960, capabilities: ["completion", "tools"] };
const LLAVA = { name: "llava", capabilities: ["completion", "tools", "vision"] };
const TTS = { name: "phonon", capabilities: ["speech"] };

function provider(modelIds: string[]): ProviderSettingsFormProvider {
  return {
    providerId: "ollama",
    executable: true,
    enabled: true,
    hasPersonalConfig: true,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "ollama" },
      api: { type: "openai-chat-completions", baseUrl: `${ROOT}/v1` },
    },
    models: modelIds.map((modelId) => ({ modelId, config: {}, hasPersonalConfig: true })),
  } as unknown as ProviderSettingsFormProvider;
}

describe("ollamaSync", () => {
  it("classifies models by capabilities", () => {
    expect(ollamaModelEligibility(QWEN)).toBe("ok");
    expect(ollamaModelEligibility({ name: "x", capabilities: ["completion"] })).toBe("noTools");
    expect(ollamaModelEligibility(TTS)).toBe("notChat");
    expect(ollamaModelEligibility({ name: "old" })).toBe("unknown");
  });

  it("creates the provider with the placeholder key and adds checked models (OL4)", () => {
    const plan = planOllamaSync({
      provider: null,
      root: ROOT,
      detected: [QWEN, LLAVA, TTS],
      checked: new Set(["qwen3", "llava", "phonon"]),
    });
    expect(plan.create).toEqual({
      access: { type: "api-key", apiKey: "ollama" },
      api: { type: "openai-chat-completions", baseUrl: `${ROOT}/v1` },
    });
    expect(plan.add).toEqual([
      {
        modelId: "qwen3",
        config: { properties: { supportsToolCall: true, contextWindow: 40960 } },
      },
      {
        modelId: "llava",
        config: {
          properties: {
            supportsToolCall: true,
            inputFormat: { supportsText: true, supportsImage: true },
          },
        },
      },
    ]);
    expect(plan.remove).toEqual([]);
  });

  it("removes an unchecked detected model and keeps one the server no longer lists (OL5, OL6)", () => {
    const plan = planOllamaSync({
      provider: provider(["qwen3", "old"]),
      root: ROOT,
      detected: [QWEN],
      checked: new Set(),
    });
    expect(plan.create).toBeNull();
    expect(plan.remove).toEqual(["qwen3"]);
  });

  it("plans only the remaining steps after a partial sync (OL8)", () => {
    const plan = planOllamaSync({
      provider: provider(["qwen3"]),
      root: ROOT,
      detected: [QWEN, LLAVA],
      checked: new Set(["qwen3", "llava"]),
    });
    expect(plan.add.map((step) => step.modelId)).toEqual(["llava"]);
    expect(
      isOllamaSyncPlanEmpty(
        planOllamaSync({
          provider: provider(["qwen3", "llava"]),
          root: ROOT,
          detected: [QWEN, LLAVA],
          checked: new Set(["qwen3", "llava"]),
        }),
      ),
    ).toBe(true);
  });

  it("reads the server root from the provider endpoint", () => {
    expect(ollamaRootFromProvider(provider([]))).toBe(ROOT);
    expect(ollamaRootFromProvider(null)).toBeNull();
  });
});
