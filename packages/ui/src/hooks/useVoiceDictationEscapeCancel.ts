import { useEffect, useRef } from "react";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

/**
 * Escape cancels an in-progress dictation. Registered in the window capture phase and consumed
 * (preventDefault + stopPropagation) only while `isActive()` is true, so the pane's bubble-phase
 * "Escape stops the agent turn" handler never sees the same keypress; while idle, Escape is left
 * untouched. Not scope-limited: cancelling must work wherever focus is.
 */
export function useVoiceDictationEscapeCancel(
  enabled: boolean,
  isActive: () => boolean,
  onCancel: () => void,
) {
  const isActiveRef = useRef(isActive);
  const onCancelRef = useRef(onCancel);
  isActiveRef.current = isActive;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeComposingKeyEvent(event) || !isActiveRef.current()) return;
      event.preventDefault();
      event.stopPropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled]);
}
