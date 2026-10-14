/**
 * React bridge to the shortcut core: the only hook entry point for the active table and display labels.
 *
 * Data comes from the shared useSettings snapshot (setting.json), so settings-page write → update → refresh
 * automatically recomputes for every consumer; no separate store or broadcast channel is introduced.
 */
import { useMemo } from "react";
import { type ShortcutCommandId } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveEffectiveShortcutBindings, type EffectiveShortcutBindings } from "./bindings.js";
import { formatShortcutBindingLabel, formatShortcutBindingLabelParts } from "./label.js";

/** Current active shortcut table (read-only view combining defaults and user overrides). */
export function useEffectiveShortcutBindings(): EffectiveShortcutBindings {
  const { settings } = useSettings();
  const overrides = settings?.shortcutBindings;
  return useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
}

/**
 * Command display label: format the first binding in the active table.
 * Unassigned (overridden by an explicit empty array) returns an empty string rather than showing the default; the shortcut shown in a tooltip must match the actual
 * active binding, or a cleared command would still show its default key in the tooltip but not respond (the display-side consequence of empty-array semantics).
 * The active table is built for the full command set; only an invalid commandId can be missing, and it is treated as unbound.
 */
export function useShortcutCommandLabel(commandId: ShortcutCommandId): string {
  const effective = useEffectiveShortcutBindings();
  const first = effective[commandId]?.[0] ?? "";
  return first === "" ? "" : formatShortcutBindingLabel(first);
}

/**
 * Same binding as useShortcutCommandLabel but split into per-key parts (["⌃", "⌥", "⌘", "K"]),
 * for keycap chips rendered as separate Kbd elements; an unassigned command returns an empty array.
 */
export function useShortcutCommandLabelParts(commandId: ShortcutCommandId): string[] {
  const effective = useEffectiveShortcutBindings();
  const first = effective[commandId]?.[0] ?? "";
  return first === "" ? [] : formatShortcutBindingLabelParts(first);
}
