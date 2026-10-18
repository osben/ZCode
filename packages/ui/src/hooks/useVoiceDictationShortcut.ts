import { useEffect, type MutableRefObject, type RefObject } from "react";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { isShortcutRecordingActive, matchesShortcutBinding } from "@/shortcuts/bindings.js";
import { isVoiceShortcutReleased } from "@/lib/voiceDictationShortcut.js";

interface UseVoiceDictationShortcutOptions {
  enabled: boolean;
  /** The shortcut is active only when this container has focus, so inputs in other panels cannot trigger recording. */
  scopeRef: RefObject<HTMLElement | null>;
  pushToTalk: boolean;
  /** The binding currently held in push-to-talk mode; shared with the recording hook, which clears it on cancel. */
  heldBindingRef: MutableRefObject<string | null>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  cancel: () => void;
}

/** Window-level voice shortcut handling: push-to-talk or toggle on the binding, cancel on window blur. */
export function useVoiceDictationShortcut({
  enabled,
  scopeRef,
  pushToTalk,
  heldBindingRef,
  start,
  stop,
  toggle,
  cancel,
}: UseVoiceDictationShortcutOptions) {
  const bindings = useEffectiveShortcutBindings();

  useEffect(() => {
    if (!enabled) return;
    const isInScope = (target: EventTarget | null) => {
      const scope = scopeRef.current;
      return Boolean(scope && target instanceof Node && scope.contains(target));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShortcutRecordingActive() || !isInScope(event.target)) return;
      const binding = bindings.voiceDictation.find((candidate) =>
        matchesShortcutBinding(event, candidate),
      );
      if (!binding) return;
      event.preventDefault();
      if (event.repeat) return;
      if (pushToTalk) {
        heldBindingRef.current = binding;
        void start();
      } else {
        void toggle();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      const held = heldBindingRef.current;
      if (!held || !isVoiceShortcutReleased(event, held)) return;
      heldBindingRef.current = null;
      void stop();
    };
    // Key release during window blur produces no keyup; cancel recording directly to avoid
    // recording forever.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", cancel);
    };
  }, [
    bindings.voiceDictation,
    cancel,
    enabled,
    heldBindingRef,
    pushToTalk,
    scopeRef,
    start,
    stop,
    toggle,
  ]);
}
