// The toolbar displays only the Composer's next-submission choices; Session is not a source for filling in a live editor.
import type { ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
/** Project only structured selections to existing display controls; do not fill empty selections from an old Snapshot or flattened aliases. */
export function resolveDraftDisplayedConfig(
  composer: Partial<SessionConfigState>,
): SessionConfigState | null {
  const selection = composer.modelSelection;
  if (!selection) return null;
  return {
    modelSelection: selection,
    provider: selection.providerId,
    model: selection.modelId,
    thought: selection.options?.reasoningLevel ?? "",
    thoughtLevels: [],
    followupMode: composer.followupMode ?? "queue",
    mode: composer.mode ?? "build",
  };
}

export function resolveDraftModelThoughtOption(
  providerId: string,
  modelId: string,
  modelSelectionView: ModelSelectionView | null,
): ZCodeConfigOption | null {
  if (!modelSelectionView) return null;
  return resolveModelThoughtOption({
    modelSelectionView,
    providerId,
    modelId,
  });
}

export function resolveDraftThoughtCurrentValue(params: {
  thought: string | null | undefined;
  thoughtLevels: readonly string[];
}): string {
  const explicitThought = params.thought?.trim() ?? "";
  if (explicitThought && params.thoughtLevels.includes(explicitThought)) {
    return explicitThought;
  }

  // The display layer previously filled empty values from directory defaults/first entries, making unbound old sessions look as if a level were selected.
  // Current values come only from selection results; the Selection entry point handles defaults for new tasks/explicit model choices, while restored empty values stay empty.
  return "";
}
