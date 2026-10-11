/**
 * Shortcut conflict policy — reserved-key blacklist, physical-equivalence normalization, conflict detection, and confirmed rebinding.
 *
 * Split out of bindings.ts (separating the core from conflict policy; bindings.ts also has a max-lines limit):
 * Key matching, recording, and the active table remain in bindings.ts; this module only answers whether a binding can be applied.
 */
import { parseShortcutBinding, SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";
import { resolveEffectiveShortcutBindings } from "./bindings.js";

/**
 * Reserved-key blacklist: native browser/editor behavior, refresh and developer tools, all function keys,
 * and single keys reserved for fixed component interactions. Compare after normalization (canonical key; see checkShortcutBindingConflict);
 * Default command bindings must not overlap these keys (unit-tested; global scope only).
 * Note: Enter is on the key-name allowlist (needed for composer scope), while among Escape/Enter/Tab/Space/Backspace,
 * it is explicitly reserved in the blacklist for global scope; Escape/Tab/Space/Backspace remain outside the key-name allowlist.
 */
export const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  // Native editing behavior (primary modifier combinations)
  ...["c", "v", "x", "z", "a", "y", "s", "p", "l"].map((key) => `CmdOrCtrl+${key}`),
  "CmdOrCtrl+Shift+z",
  // Refresh and developer tools.
  "CmdOrCtrl+r",
  "CmdOrCtrl+Shift+r",
  "CmdOrCtrl+Shift+i",
  "CmdOrCtrl+Shift+j",
  "CmdOrCtrl+Shift+c",
  // Entire function-key range (any modifier combination with F1-F12).
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+Shift+F${index + 1}`),
  // Arrow keys alone (fixed component interactions).
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  // Enter: once allowed by the key-name allowlist, explicitly block it in the global scope
  // (making dialog confirmation global would break every confirmation interaction); the composer scope is unaffected.
  "Enter",
]);

/**
 * Fixed accelerator ⌘M for the macOS system-menu role:"minimize" (new scenario B):
 * The system menu consumes the key before the renderer, so binding it would be inert; no command in any scope may occupy or steal it.
 * Applies only on macOS—on Windows/Linux, CmdOrCtrl+m is physically equivalent to Ctrl+M (the default openModelMenu binding),
 * so use conflict detection rather than a reserved-key block. After the three toolbar shortcuts were finalized, this is the only macOS guard for CmdOrCtrl+m.
 */
const MACOS_MENU_RESERVED_BINDINGS: ReadonlySet<string> = new Set(["CmdOrCtrl+m"]);

/**
 * Physical-equivalence normalization used only for conflict detection (new): treat platform-equivalent combinations as the same physical key
 * (CmdOrCtrl ≡ explicit Ctrl on Windows/Linux; AltGr adds the Alt bit). If conflict detection compares strings exactly,
 * a platform-normalized recorder value (for example, recording ⌃M on Windows yields "CmdOrCtrl+m") bypasses occupancy checks
 * for explicit Ctrl defaults such as the toolbar's "Ctrl+m", causing a silent conflict with no warning.
 * Normalize into a stable comparison key according to the core modifiersMatch semantics:
 * - Non-Apple: primary = cmdOrCtrl | ctrl | altGr (same physical primary modifier), alt = alt | altGr
 * - Apple: primary = cmdOrCtrl (meta), secondaryCtrl = ctrl (separate physical key), alt = alt | altGr
 */
function canonicalBindingKey(binding: string, isApple: boolean): string | null {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return null;
  }
  if (isApple) {
    // On Apple, modifiersMatch's wantPrimaryOrCtrl also treats altGr as a primary modifier
    // (AltGr+m ≡ ⌘⌥M ≡ CmdOrCtrl+Alt+m), so include it in canonical primary-modifier normalization.
    return `${parsed.cmdOrCtrl || parsed.altGr ? 1 : 0}${parsed.ctrl ? 1 : 0}${
      parsed.alt || parsed.altGr ? 1 : 0
    }${parsed.shift ? 1 : 0}:${parsed.key}`;
  }
  return `${parsed.cmdOrCtrl || parsed.ctrl || parsed.altGr ? 1 : 0}${
    parsed.alt || parsed.altGr ? 1 : 0
  }${parsed.shift ? 1 : 0}:${parsed.key}`;
}

/**
 * Whether two binding strings represent the same physical combination (canonical keys match). Search reuses the same normalization
 * as conflict detection; Settings “search by shortcut” uses it to match CmdOrCtrl+m recorded on Windows with explicit Ctrl+m.
 * If either string fails to parse, they are not equal (matching conflict detection's null short-circuit behavior).
 */
export function isSamePhysicalBinding(
  a: string,
  b: string,
  options?: { platformInfo?: KeyboardShortcutPlatformInfo },
): boolean {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const keyA = canonicalBindingKey(a, isApple);
  const keyB = canonicalBindingKey(b, isApple);
  return keyA !== null && keyA === keyB;
}

/** Canonical comparison keys for the reserved-key blocklist (built lazily per platform; canonicalization also blocks equivalent variants edited manually into setting.json). */
let reservedCanonicalKeysCache: {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} | null = null;
function getReservedCanonicalKeys(): {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} {
  if (reservedCanonicalKeysCache === null) {
    const apple = new Set<string>();
    const nonApple = new Set<string>();
    for (const binding of RESERVED_BINDINGS) {
      const appleKey = canonicalBindingKey(binding, true);
      if (appleKey !== null) {
        apple.add(appleKey);
      }
      const nonAppleKey = canonicalBindingKey(binding, false);
      if (nonAppleKey !== null) {
        nonApple.add(nonAppleKey);
      }
    }
    reservedCanonicalKeysCache = { apple, nonApple };
  }
  return reservedCanonicalKeysCache;
}

export interface ShortcutBindingConflict {
  kind: "reserved" | "occupied";
  /** Command occupying the binding, if occupied. */
  ownerCommandId?: ShortcutCommandId;
  binding: string;
}

/**
 * Conflict detection (reject + highlight policy): whether binding newBinding to commandId should be rejected.
 * Returns null when the binding is allowed. Existing bindings for commandId itself are not conflicts (overrides replace the whole group).
 * Scope isolation: check occupancy only against commands in the **same scope** (composer CmdOrCtrl+Enter may coexist with a global command);
 * the reserved-key blocklist rejects rebinding only in the global scope.
 * Physical-equivalence normalization (new): compare blocklist and occupancy using canonical keys so platform-equivalent
 * combinations (CmdOrCtrl ≡ Ctrl on Windows/Linux) are not missed.
 */
export function checkShortcutBindingConflict(
  commandId: ShortcutCommandId,
  newBinding: string,
  overrides?: Record<string, readonly string[]>,
  options?: {
    menuChannelReserved?: boolean;
    /** Defaults to the runtime navigator (tests pass a platform explicitly to pin semantics). */
    platformInfo?: KeyboardShortcutPlatformInfo;
  },
): ShortcutBindingConflict | null {
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalBindingKey(newBinding, isApple);
  // The macOS ⌘M minimize guard applies to every scope: the system menu consumes the key before renderer dispatch,
  // so binding it to a composer command would also be inert.
  if (isApple && MACOS_MENU_RESERVED_BINDINGS.has(newBinding)) {
    return { kind: "reserved", binding: newBinding };
  }
  if (commandScope === "global") {
    if (newKey !== null && getReservedCanonicalKeys()[isApple ? "apple" : "nonApple"].has(newKey)) {
      return { kind: "reserved", binding: newBinding };
    }
  }
  const effective = resolveEffectiveShortcutBindings(overrides);
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // Scope isolation: the same key in another scope is not a conflict.
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    for (const binding of effective[entry.id] ?? []) {
      const candidateKey = canonicalBindingKey(binding, isApple);
      if (newKey !== null && candidateKey === newKey) {
        // Web menu-channel commands are not configurable, but their default keys are still consumed by the root fallback listener
        // (useRootPlatformEffects responds to Cmd/Ctrl+N and O). Reject these as reserved keys; do not offer a steal-binding flow
        // or one shortcut would trigger two actions.
        if (options?.menuChannelReserved && entry.channel === "menu") {
          return { kind: "reserved", binding: newBinding };
        }
        return { kind: "occupied", ownerCommandId: entry.id, binding: newBinding };
      }
    }
  }
  return null;
}

/**
 * “Steal binding” after a second confirmation (allow rebinding an occupied app command):
 * Bind newBinding to commandId using row-level semantics, then remove it from the effective bindings of other commands that currently occupy it.
 * Write the displaced command's overrides as its effective bindings minus newBinding; this may be an explicit empty array (= unset, do not restore defaults).
 * Physical-equivalence normalization (new): remove platform-equivalent entries too (for example, Ctrl+m and CmdOrCtrl+m on Windows).
 * Row-level semantics: stealing changes only the conflict-resolution method, not the row-level operation selected by the user.
 * options.mode/bindingIndex match recording state: replace + index replaces that entry (keeping the rest);
 * add or bindingIndex=null (no slot assigned, recording the first binding) appends; omitted options (legacy callers) replace the whole group with one key.
 */
export function buildShortcutOverridesAfterSteal(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
  options?: {
    platformInfo?: KeyboardShortcutPlatformInfo;
    /** Recording mode (from Settings RecordingState): replace = replace one row; add = append; omitted = replace the whole group. */
    mode?: "replace" | "add";
    /** Target index in replace mode. */
    bindingIndex?: number | null;
  },
): Record<string, string[]> {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalBindingKey(newBinding, isApple);
  const effective = resolveEffectiveShortcutBindings(overrides);
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  const currentBindings = effective[commandId] ?? [];
  if (options?.mode === "replace" && options.bindingIndex != null) {
    const target = options.bindingIndex;
    next[commandId] = currentBindings.map((binding, index) =>
      index === target ? newBinding : binding,
    );
  } else if (options?.mode === "add" || options?.bindingIndex === null) {
    next[commandId] = [...currentBindings, newBinding];
  } else {
    next[commandId] = [newBinding];
  }
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // Scope isolation: stealing clears occupancy only from commands in the same scope.
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    const remaining = (effective[entry.id] ?? []).filter((binding) => {
      const candidateKey = canonicalBindingKey(binding, isApple);
      return newKey === null || candidateKey !== newKey;
    });
    if (remaining.length !== (effective[entry.id] ?? []).length) {
      next[entry.id] = remaining;
    }
  }
  return next;
}

/**
 * “Add binding” (one command may have multiple shortcuts, displayed as A / B): append newBinding after the command's current effective bindings
 * (including defaults). Overrides replace the whole group, so append must write the complete list of defaults + existing overrides;
 * otherwise unoverridden default shortcuts would be lost.
 * The caller (Settings recording entry) rejects physical-equivalent duplicates within one command first; do not validate them again here.
 */
export function buildShortcutOverridesAfterAppend(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = [...(effective[commandId] ?? []), newBinding];
  return next;
}

/**
 * Row-level operations for the split-binding model all write the full effective list back to
 * overrides, using three paired builders: AfterAppend (append one), WithoutBindingAt (delete item
 * at index; deleting all writes explicit [] for unassigned), and WithBindingAt (replace item at
 * index). The settings-page recording entry point rejects physically equivalent duplicates for the same command.
 */

/** Split-row delete: remove the effective-list item at bindingIndex and write the whole group back to overrides (spec §8). */
export function buildShortcutOverridesWithoutBindingAt(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  bindingIndex: number,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = (effective[commandId] ?? []).filter((_, index) => index !== bindingIndex);
  return next;
}

/** Split-row replacement: replace the effective-list item at bindingIndex with newBinding and write the whole group back to overrides (spec §8). */
export function buildShortcutOverridesWithBindingAt(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  bindingIndex: number,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = (effective[commandId] ?? []).map((binding, index) =>
    index === bindingIndex ? newBinding : binding,
  );
  return next;
}
