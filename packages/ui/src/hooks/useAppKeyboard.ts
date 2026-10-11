import { useEffect, useRef } from "react";
import { SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutRecordingActive,
  matchesShortcutBinding,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";

/** Handler table for window-channel shortcuts: command ID → callback; null/missing means the command is currently unavailable. */
export type AppKeyboardHandlers = Partial<Record<ShortcutCommandId, (() => void) | null>>;

/**
 * Thin global keyboard-dispatch wrapper: window keydown capture → shared shortcut matching → command handler.
 *
 * - Key knowledge stays in the shortcuts core (active bindings + matcher); this hook does not know individual keys.
 * - Do not preventDefault when a handler is null/missing, allowing browser defaults (such as history navigation) when unavailable.
 * - Capture phase intercepts events so browser or desktop-shell defaults do not take them when focus is in ordinary page content.
 * - Register the listener once and pass handlers/active bindings through refs, so the next keypress uses settings-page changes immediately.
 */
export function useAppKeyboard(handlers: AppKeyboardHandlers) {
  const effective = useEffectiveShortcutBindings();
  const stateRef = useRef({ handlers, effective });
  stateRef.current = { handlers, effective };

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) {
        return;
      }
      // Short-circuit during recording: the recording listener is registered after this listener and same-phase listeners
      // run in registration order. Without this guard, the recorded combination triggers its original command first, so rebinding never succeeds (see setShortcutRecordingActive).
      if (isShortcutRecordingActive()) {
        return;
      }

      const { handlers: currentHandlers, effective: currentEffective } = stateRef.current;
      // A Shift+printable-key binding (such as Shift+f) is the same physical event as typing an uppercase letter.
      // Skip these bindings when focus is in an editable element (chat input/search/terminal), or users cannot type that uppercase letter.
      const editableTarget = isEditableShortcutEventTarget(event.target);
      for (const entry of SHORTCUT_COMMANDS) {
        if (entry.channel !== "window") {
          continue;
        }
        // Composer-scoped commands are handled by the input's Lexical plugin; global dispatch does not see them.
        if (entry.scope === "composer") {
          continue;
        }
        const handler = currentHandlers[entry.id];
        if (!handler) {
          continue;
        }
        const bindings = currentEffective[entry.id];
        if (!bindings || bindings.length === 0) {
          continue;
        }
        for (const binding of bindings) {
          if (editableTarget && isShiftOnlyPrintableBinding(binding)) {
            continue;
          }
          if (matchesShortcutBinding(event, binding)) {
            event.preventDefault();
            handler();
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, []);
}
