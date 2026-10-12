import { parseShortcutBinding } from "@zcode/shared";

const MODIFIER_RELEASE_KEYS: Readonly<Record<string, readonly string[]>> = {
  CmdOrCtrl: ["Meta", "Control"],
  Ctrl: ["Control"],
  Alt: ["Alt"],
  AltGr: ["AltGraph"],
  Shift: ["Shift"],
};

/**
 * Whether a keyup releases part of the voice shortcut (the main key or any modifier).
 * In push-to-talk mode, releasing ends the recording.
 */
export function isVoiceShortcutReleased(
  event: Pick<KeyboardEvent, "key" | "code">,
  binding: string,
): boolean {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return false;
  if (event.key.length === 1 && event.key.toLowerCase() === parsed.key) return true;
  if (event.code === `Key${parsed.key.toUpperCase()}` && /^[a-z]$/.test(parsed.key)) return true;
  // Named main keys (F5, Enter, ArrowUp...) do not take the letter-code branch: their
  // event.key.length > 1 and the canonical name matches event.key exactly, so compare directly;
  // otherwise releasing the main key while holding a modifier cannot end push-to-talk.
  if (event.key.length > 1 && event.key === parsed.key) return true;
  const modifierKeys = [
    parsed.cmdOrCtrl ? MODIFIER_RELEASE_KEYS.CmdOrCtrl : [],
    parsed.ctrl ? MODIFIER_RELEASE_KEYS.Ctrl : [],
    parsed.alt ? MODIFIER_RELEASE_KEYS.Alt : [],
    parsed.altGr ? MODIFIER_RELEASE_KEYS.AltGr : [],
    parsed.shift ? MODIFIER_RELEASE_KEYS.Shift : [],
  ].flat();
  return modifierKeys.includes(event.key);
}
