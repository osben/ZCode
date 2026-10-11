import type {
  ZCodeConfigOption,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeSessionMode,
  ZCodeSessionSettingsState,
  ZCodeSessionStateSnapshot,
  ZCodeTaskModeInfo,
} from "@zcode/shared";
import {
  formatModelPickerValue as formatSharedModelSelection,
  getZCodeAgentAvailableModes as getSharedZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode as normalizeSharedAvailableZCodeMode,
  zcodeSessionSettingsToZCodeConfigOptions,
} from "@zcode/shared";

export const MODEL_CONFIG_ID = "model";
export const MODE_CONFIG_ID = "mode";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

function resolveLatestMessageModelSelection(
  messages: readonly ZCodeMessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}

function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): ModelSelection | undefined {
  // Historically, resume could overwrite settings.current with the app's current default model,
  // while message info.model still retained the model actually used. Task metadata is a restore hint,
  // so prefer the model used by the latest message to prevent an incorrect snapshot from polluting the task index.
  return resolveLatestMessageModelSelection(snapshot.messages) ?? snapshot.settings.model.current;
}

export function formatTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): string {
  return formatModelPickerValue(resolveTaskMetaModelSelectionFromSnapshot(snapshot));
}

export function normalizeAvailableZCodeMode(mode: ZCodeSessionMode): string {
  return normalizeSharedAvailableZCodeMode(mode);
}

export function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return getSharedZCodeAgentAvailableModes();
}

export function settingsToConfigOptions(settings: ZCodeSessionSettingsState): ZCodeConfigOption[] {
  // The service once maintained its own three-mode allowlist and did not update it when edit mode launched;
  // changing modes then made mode_update overwrite the UI menu with build/plan/yolo. Reuse the shared source of truth here.
  return zcodeSessionSettingsToZCodeConfigOptions(settings);
}
