import type { ModelSelectionView } from "@zcode/provider";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";

/** Both domains exist so the tool can only pick the current account domain instead of guessing by provider order. */
export function offPeakSelectionView(
  values: readonly string[] = ["disabled", "high", "max"],
): ModelSelectionView {
  return {
    revision: 1,
    providers: (["bigmodel", "zai"] as const).map((family) => ({
      providerId: OFF_PEAK_PROVIDER_IDS[family],
      config: { visibility: "hidden" },
      models: [family === "zai" ? "ZAI-only" : "BigModel-only", "GLM-5.2"].map((modelId) => ({
        modelId,
        config: {
          enabled: true,

          properties: {
            requiresMfjsToolSchema: false,
            contextWindow: 200000,
            inputFormat: {
              supportsText: true,
              supportsImage: false,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: false,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          },
          optionSpecs: {
            reasoningLevel: { values, map: "{}" },
            maxOutputTokens: { max: 32000, map: "{}" },
          },
        },
      })),
    })),
  };
}
