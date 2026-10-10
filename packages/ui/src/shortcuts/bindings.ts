/**
 * Shortcut execution core — the single implementation for matching, recording, the active binding table, and conflict detection.
 *
 * - Keybinding knowledge (format parsing, platform modifier semantics, reserved keys) must exist only in this module and shared/shortcutCommands.ts;
 * - everything is a pure function, with DOM events passed as structured arguments so unit tests can cover key-combination edge cases;
 * - IME composition (isComposing / Process / Dead / keyCode 229) and key repeat never match or record.
 */
import {
  type ParsedShortcutBinding,
  type ShortcutCommandId,
  parseShortcutBinding,
  serializeShortcutBinding,
  SHORTCUT_COMMANDS,
} from "@zcode/shared";
import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";

/** Keyboard event shape required for matching/recording (a subset of KeyboardEvent that tests can construct). */
export interface ShortcutBindingEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** Support the legacy event model; Chromium reports keyCode 229 during IME composition, including Chinese input. */
  keyCode?: number;
}

// ============================================================================
// Noise filtering (IME / key repeat)
// ============================================================================

/** Check whether an event is in IME composition (isComposing / Process / Dead / keyCode 229). */
function isImeEvent(event: ShortcutBindingEvent): boolean {
  return (
    event.isComposing === true ||
    event.key === "Process" ||
    event.key === "Dead" ||
    event.keyCode === 229
  );
}

/** Check whether an event is noise that should not trigger a shortcut: key repeat, IME composition, or a dead key. */
function isShortcutEventNoise(event: ShortcutBindingEvent): boolean {
  return event.repeat === true || isImeEvent(event);
}

// ============================================================================
// event.code → canonical key name mapping (reliable across keyboard layouts)
// ============================================================================

const CODE_TO_KEY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      `Key${String.fromCharCode(65 + index)}`,
      String.fromCharCode(97 + index),
    ]),
  ),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Digit${index}`, String(index)])),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`]),
  ),
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  // Enter is available for recording/matching composer-scoped commands; NumpadEnter is not mapped (preserves its undefined behavior)
  Enter: "Enter",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
  Insert: "Insert",
};

/** Canonical key name → expected event.code (an extension of the existing keyboardShortcuts.getExpectedShortcutCode). */
const KEY_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CODE_TO_KEY).map(([code, key]) => [key, code]),
);

// ============================================================================
// Generic matcher
// ============================================================================

/**
 * Generic match: determine whether a binding (canonical serialized string) matches a keyboard event.
 *
 * Modifiers must match exactly: the modifiers actually pressed must match those declared by the binding,
 * and extra modifiers (for example, Cmd+Ctrl+K for CmdOrCtrl+K) do not count as a match.
 * - CmdOrCtrl: macOS = meta without ctrl; Windows/Linux = ctrl without meta (platform separation follows keyboardShortcuts.ts);
 * - Ctrl: explicit Ctrl; equivalent to CmdOrCtrl on Windows/Linux (recording on these platforms only produces CmdOrCtrl);
 * - AltGr: on Windows/Linux, Chromium reports physical AltGr as ctrl+alt pressed together.
 */
export function matchesShortcutBinding(
  event: ShortcutBindingEvent,
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  if (isShortcutEventNoise(event)) {
    return false;
  }
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }

  const isApple = isAppleKeyboardPlatform(platformInfo);
  if (!modifiersMatch(event, parsed, isApple)) {
    return false;
  }
  return eventMatchesKey(event, parsed.key);
}

function modifiersMatch(
  event: ShortcutBindingEvent,
  parsed: ParsedShortcutBinding,
  isApple: boolean,
): boolean {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event;

  // AltGr and Ctrl+Alt are physically indistinguishable (existing Windows/Linux bindings such as Ctrl+Alt+B use the same chord),
  // so AltGr bindings match the same physical chord as cmdOrCtrl/ctrl + Alt bindings; do not treat them as exclusive.
  const wantPrimaryOrCtrl = parsed.altGr || parsed.cmdOrCtrl || (!isApple && parsed.ctrl);
  const wantCtrl = !parsed.altGr && !parsed.cmdOrCtrl && parsed.ctrl && isApple;
  const wantAlt = parsed.altGr || parsed.alt;

  // Bare-key bindings (Enter/F5/arrow keys, with no primary modifier) require primary modifiers to be released,
  // or Cmd+Enter would incorrectly match bare Enter. This gap was latent while every command had a primary modifier, but became critical when Enter was added.
  if (!wantPrimaryOrCtrl && !wantCtrl && (meta || ctrl)) {
    return false;
  }

  if (wantPrimaryOrCtrl) {
    const ok = isApple ? meta && !ctrl : ctrl && !meta;
    if (!ok) {
      return false;
    }
  }
  if (wantCtrl) {
    // Explicit Ctrl on macOS (reserved for system Emacs editing behavior; only active when explicitly bound by the user).
    if (!ctrl || meta) {
      return false;
    }
  }
  if (wantAlt !== alt) {
    return false;
  }
  return parsed.shift === shift;
}

/**
 * Check for a Shift-only binding to one printable character (such as Shift+f).
 * This kind of binding is the same physical event as “typing an uppercase letter”; when the event target is editable,
 * allow it through; otherwise preventDefault swallows the key and triggers the command instead of typing the uppercase letter.
 */
export function isShiftOnlyPrintableBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }
  return (
    !parsed.cmdOrCtrl &&
    !parsed.ctrl &&
    !parsed.alt &&
    !parsed.altGr &&
    parsed.shift &&
    parsed.key.length === 1
  );
}

/**
 * Whether the shortcut event target is editable (input/textarea/select or contenteditable).
 * Used with isShiftOnlyPrintableBinding: skip Shift-only printable bindings inside editable targets.
 * Always false without a DOM (Node unit tests).
 */
export function isEditableShortcutEventTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Key matching: compare lowercased event.key first, with event.code as fallback (macOS Option transformations and non-US layouts). */
function eventMatchesKey(event: Pick<ShortcutBindingEvent, "key" | "code">, key: string): boolean {
  if (event.key === key) {
    return true;
  }
  if (event.key.length === 1 && event.key.toLowerCase() === key) {
    return true;
  }
  if (event.code !== undefined) {
    return KEY_TO_CODE[key] === event.code;
  }
  return false;
}

// ============================================================================
// Recorder
// ============================================================================

type ShortcutRecordResult =
  | { kind: "pending" }
  | { kind: "binding"; binding: string }
  | { kind: "invalid"; reason: "no-modifier" | "unsupported-key" };

function isModifierOnlyKey(key: string): boolean {
  return (
    key === "Shift" ||
    key === "Control" ||
    key === "Meta" ||
    key === "Alt" ||
    key === "AltGraph" ||
    key === "OS"
  );
}

/**
 * Record a keyboard event as a canonical binding string.
 *
 * - pending: only a modifier was pressed, or IME noise has no reverse-mappable code — keep waiting for the user to press a complete combination;
 * - binding: a valid combination (normalize the primary modifier by platform: macOS Cmd and Windows/Linux Ctrl → CmdOrCtrl; preserve explicit Ctrl on macOS);
 * - invalid: an ordinary key without modifiers (except function and arrow keys), or an unsupported key.
 *
 * For key names, prefer reverse-mapping the physical base key from event.code (Shift+7 records “7” rather than “&” on any layout),
 * and use event.key only as a fallback. The key is unreliable during IME composition (isComposing/Process/229), but
 * event.code still identifies the physical key. Recording is an explicit intent after clicking the record button;if a Chinese IME is active and focus is in
 * an editable element, Shift+letter may be consumed by the IME as composition input. Still record by code (matching continues to filter it,
 * see isShortcutEventNoise). The settings UI handles Escape/Backspace recording behavior (cancel/clear).
 */
export function recordShortcutBinding(
  event: ShortcutBindingEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  if (event.repeat === true || isModifierOnlyKey(event.key)) {
    return { kind: "pending" };
  }

  if (isImeEvent(event)) {
    const codeKey = event.code !== undefined ? CODE_TO_KEY[event.code] : undefined;
    if (codeKey === undefined) {
      return { kind: "pending" };
    }
    return buildRecordedBinding(event, codeKey, platformInfo);
  }

  const key =
    event.code !== undefined
      ? (CODE_TO_KEY[event.code] ?? normalizeEventKey(event.key))
      : normalizeEventKey(event.key);
  if (key === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return buildRecordedBinding(event, key, platformInfo);
}

/** Recording finalization: validate modifiers, normalize by platform, and serialize (the caller has already extracted the key name). */
function buildRecordedBinding(
  event: ShortcutBindingEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  // Named keys such as function and arrow keys (multiple characters) may be bound alone; ordinary character keys require at least one modifier.
  const namedKey = key.length > 1;
  if (!hasModifier && !namedKey) {
    return { kind: "invalid", reason: "no-modifier" };
  }

  const parsed: ParsedShortcutBinding = {
    // AltGr and Ctrl+Alt are physically indistinguishable, so recording always produces CmdOrCtrl+Alt (users think of the chord as Ctrl+Alt).
    cmdOrCtrl: isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey,
    ctrl: isApple ? event.ctrlKey && !event.metaKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    altGr: false,
    key,
  };

  // After platform normalization, macOS Cmd+Ctrl combinations and Windows/Linux Meta-only (Win key) combinations
  // have both cmdOrCtrl and ctrl set to false, even though the raw event passed the hasModifier check above; serialization would produce
  // a bare key (such as “k”), which is not reserved and does not trigger conflict detection; after saving, pressing that key anywhere would match
  // the command and swallow input. Validate before serialization that normalization did not drop the primary modifier.
  if ((event.metaKey || event.ctrlKey) && !parsed.cmdOrCtrl && !parsed.ctrl) {
    return { kind: "invalid", reason: "unsupported-key" };
  }

  const binding = serializeShortcutBinding(parsed);
  if (binding === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return { kind: "binding", binding };
}

/** event.key → canonical key name (fallback only): lowercase single characters and preserve named keys. */
function normalizeEventKey(rawKey: string): string | null {
  if (rawKey.length === 1) {
    return /^[a-zA-Z0-9[\]=\-,./;'\\`]$/.test(rawKey) ? rawKey.toLowerCase() : null;
  }
  return rawKey in KEY_TO_CODE ? rawKey : null;
}

// ============================================================================
// Recording-mode suppression
// ============================================================================

let shortcutRecordingActive = false;

/**
 * Set to true when the settings page enters shortcut recording mode.
 * The recorder and useAppKeyboard both listen on window capture, but the recorder registers later (when the record button is clicked),
 * and listeners in the same phase run in registration order. The recorded combination would trigger the original command before recording, making rebinding impossible.
 * useAppKeyboard checks this flag before dispatch and exits early; for the menu channel, platform.setShortcutRecordingActive
 * tells main to temporarily remove menu accelerators (on macOS, the system menu consumes keys before the renderer).
 */
export function setShortcutRecordingActive(active: boolean): void {
  shortcutRecordingActive = active;
}

export function isShortcutRecordingActive(): boolean {
  return shortcutRecordingActive;
}

// ============================================================================
// Active binding table
// ============================================================================

export type EffectiveShortcutBindings = Readonly<Record<ShortcutCommandId, readonly string[]>>;

/**
 * Compute the active binding table from command defaults plus user overrides (replace the entire set).
 * An explicit empty array means the user cleared the binding to “unset” (the active table stays empty instead of reverting to the default; rebinding another command can clear the displaced command this way);
 * if every entry is invalid, fall back to defaults (invalid entries manually added to setting.json must not disable all shortcuts).
 */
export function resolveEffectiveShortcutBindings(
  overrides?: Record<string, readonly string[]>,
): EffectiveShortcutBindings {
  const effective: Record<ShortcutCommandId, readonly string[]> = {} as Record<
    ShortcutCommandId,
    readonly string[]
  >;
  for (const entry of SHORTCUT_COMMANDS) {
    const override = overrides?.[entry.id];
    if (override === undefined) {
      effective[entry.id] = entry.defaultBindings;
      continue;
    }
    const valid = override.filter((binding) => parseShortcutBinding(binding) !== null);
    if (override.length > 0 && valid.length === 0) {
      logger.warn("[shortcuts] 覆盖绑定全部非法，回退默认", { commandId: entry.id, override });
      effective[entry.id] = entry.defaultBindings;
      continue;
    }
    if (valid.length !== override.length) {
      logger.warn("[shortcuts] 忽略非法覆盖条目", { commandId: entry.id, override });
    }
    effective[entry.id] = valid;
  }
  return effective;
}
