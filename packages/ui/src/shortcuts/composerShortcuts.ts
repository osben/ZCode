/**
 * Composer-scoped shortcut resolution — a standalone module whose only consumer is
 * the LexicalChatInput keyboard behavior plugin; useAppKeyboard, menus, and Web fallback listeners
 * has no awareness of composer commands. It depends only on the core matcher, not DOM/React, and can be unit-tested independently.
 */
import type { ShortcutBindingEvent } from "./bindings.js";
import { matchesShortcutBinding } from "./bindings.js";

/** Slice of composer-scoped commands in the active table (only these two are needed, avoiding a type dependency on the full table). */
interface ComposerEffectiveBindings {
  readonly composerSend: readonly string[];
  readonly composerInsertNewline: readonly string[];
}

/** Final action for an Enter-family event inside the composer. */
type ComposerKeyAction = "send" | "newline";

/**
 * Resolve the composer action from the active table (rebinding layer, with a consistent permissive policy).
 *
 * Match all active bindings for `composerInsertNewline` / `composerSend` (check newline first because
 * accidentally sending is more costly than an edit operation) — **not limited to Enter keys**: users can bind Send to any key, such as F9,
 * consistent with the permissive policy for other commands; return the matching action or null if none match (the caller follows the existing main path).
 *
 * Runtime guards for sending (submitDisabled / enterSubmits on mobile viewport / empty input /
 * yielding to reverse delivery) are handled by the caller; this function answers only what the keybinding table dictates.
 */
export function resolveComposerKeyAction(
  event: Pick<ShortcutBindingEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  effective: ComposerEffectiveBindings,
  platformInfo?: { platform?: string; userAgent?: string },
): ComposerKeyAction | null {
  for (const binding of effective.composerInsertNewline ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "newline";
    }
  }
  for (const binding of effective.composerSend ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "send";
    }
  }
  return null;
}

/**
 * Whether bare Enter should fall back to a newline (pre-dispatch check):
 * When the user has rebound `composerSend` (active bindings no longer include bare Enter, including an explicit empty array meaning unset),
 * bare Enter no longer means Send, so allow Lexical to insert a newline — expected behavior after rebinding for users who prefer Ctrl+Enter.
 */
export function shouldBareEnterFallThroughToNewline(effective: ComposerEffectiveBindings): boolean {
  return !effective.composerSend.includes("Enter");
}
