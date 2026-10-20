import { useCallback, useEffect, useState } from "react";
import { recordShortcutBinding } from "@/shortcuts/bindings.js";

export interface ShortcutKeySearch {
  /** Armed state: waiting for the user to press a key combination. */
  armed: boolean;
  /** Captured combination (null = key filtering disabled). The settings page manages exclusive keyboard suppression based on armed. */
  binding: string | null;
  /** Toggle armed state. The caller must cancel inline recording first (mutually exclusive; see ShortcutSettingsSection). */
  toggle: () => void;
  /** Exit armed state (keep filtering by the captured combination). */
  disarm: () => void;
  /** Clear the captured combination (return to text-only filtering). */
  clear: () => void;
}

/**
 * Settings-page “search by key combination” state machine (same behavior as VS Code keyboard shortcuts):
 * Escape exits armed state; Backspace clears the captured combination; other events are captured by the core recorder
 * (including platform normalization), and on success armed state exits while filtering remains until manually cleared.
 * Ignore keys that cannot appear in the command table, such as bare letters (recorder marks invalid), and wait for the next valid combination.
 * Filtering uses the same comparison as conflicts.isSamePhysicalBinding (physical equivalence, e.g. Win Ctrl+m ≡ CmdOrCtrl+m),
 * so it checks the same binding set as conflict detection.
 */
export function useShortcutKeySearch(): ShortcutKeySearch {
  const [armed, setArmed] = useState(false);
  const [binding, setBinding] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) {
      return;
    }
    function handleKeySearchKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setArmed(false);
        return;
      }
      if (event.key === "Backspace") {
        setBinding(null);
        return;
      }
      const result = recordShortcutBinding(event);
      if (result.kind !== "binding") {
        return;
      }
      setBinding(result.binding);
      setArmed(false);
    }

    window.addEventListener("keydown", handleKeySearchKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleKeySearchKeydown, true);
    };
  }, [armed]);

  const toggle = useCallback(() => setArmed((current) => !current), []);
  const disarm = useCallback(() => setArmed(false), []);
  const clear = useCallback(() => setBinding(null), []);

  return { armed, binding, toggle, disarm, clear };
}
