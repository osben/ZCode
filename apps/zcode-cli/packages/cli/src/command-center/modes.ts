import type { SwitchableCommandCenterMode } from "./types.js";

const SWITCHABLE_COMMAND_CENTER_MODES = [
  "plan",
  "build",
  "edit",
  "guarded",
  "yolo",
] as const satisfies readonly SwitchableCommandCenterMode[];

export function formatAvailableCommandCenterModes(): string {
  // The menu no longer recommends Edit; explicit legacy commands still go through full value validation and do not trigger a mode migration.
  return SWITCHABLE_COMMAND_CENTER_MODES.filter((mode) => mode !== "edit").join(", ");
}

export function isSwitchableCommandCenterMode(value: string): value is SwitchableCommandCenterMode {
  return SWITCHABLE_COMMAND_CENTER_MODES.includes(value as SwitchableCommandCenterMode);
}
