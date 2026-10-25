/**
 * Shortcut display label — format a binding string for the platform.
 * Split out of bindings.ts (display is separate from matching/recording/conflicts, and bindings.ts has a max-lines limit).
 */
import { parseShortcutBinding } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";

const NAMED_KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * Binding string → per-key tokens (for rendering keycaps in settings): macOS ["⇧","⌘","P"],
 * Windows/Linux ["Ctrl","Shift","P"]. Labels and keycaps share the same token sequence,
 * so ordering is defined in one place; rendering each token as a separate Kbd keycap keeps its size stable.
 */
export function formatShortcutBindingLabelParts(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string[] {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return [binding];
  }

  const displayKey =
    NAMED_KEY_GLYPHS[parsed.key] ??
    (parsed.key === "=" ? "+" : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  const isApple = isAppleKeyboardPlatform(platformInfo);

  if (isApple) {
    // Apple-standard modifier order: ⌃ ⌥ ⇧ ⌘
    const parts: string[] = [];
    if (parsed.altGr) {
      parts.push("⌃", "⌥");
    } else {
      if (parsed.ctrl) {
        parts.push("⌃");
      }
      if (parsed.alt) {
        parts.push("⌥");
      }
    }
    if (parsed.shift) {
      parts.push("⇧");
    }
    if (parsed.cmdOrCtrl) {
      parts.push("⌘");
    }
    parts.push(displayKey);
    return parts;
  }

  const parts: string[] = [];
  if (parsed.cmdOrCtrl || parsed.ctrl) {
    parts.push("Ctrl");
  }
  if (parsed.altGr) {
    parts.push("Alt");
  } else if (parsed.alt) {
    parts.push("Alt");
  }
  if (parsed.shift) {
    parts.push("Shift");
  }
  parts.push(displayKey);
  return parts;
}

/**
 * Binding string → platform display label. macOS uses symbols (⌘ K, ⌃ ⌥ ⇧ ⌘ P); Windows/Linux use
 * the Ctrl+Shift+P style; display "=" as "+" (zoom semantics), arrows as glyphs, and other named keys as text.
 */
export function formatShortcutBindingLabel(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  return formatShortcutBindingLabelParts(binding, platformInfo).join(
    isAppleKeyboardPlatform(platformInfo) ? " " : "+",
  );
}
