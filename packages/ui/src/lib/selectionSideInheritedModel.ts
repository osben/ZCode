import type { ModelSelectionView } from "@zcode/provider";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

/** The side pane inherits the parent runtime’s effective model; do not carry the main Composer’s unsubmitted draft into the new child. */
export function resolveSelectionSideInheritedModel(
  config: SessionConfigState | null | undefined,
  view: ModelSelectionView | null,
) {
  if (!config) return null;
  return (
    createComposerSubmissionConfig(
      {
        mode: config.mode,
        modelSelection: {
          providerId: config.provider,
          modelId: config.model,
          options: { reasoningLevel: config.thought },
        },
      },
      view,
    )?.modelSelection ?? null
  );
}
