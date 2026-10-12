/**
 * Shortcut command table and binding serialization format: the single source of truth for shortcuts across the repository.
 *
 * Design constraints:
 * - This file contains only pure data and functions, with no DOM / Electron dependencies, and is shared by renderer / main / services.
 * - The same binding-string format is used in setting.json, renderer matching, and Electron menu accelerators.
 * - Key-mapping knowledge belongs here; consumers (useAppKeyboard, Settings, menus) must not parse keys independently.
 */

/** Shortcut dispatch channel: window = renderer keyboard dispatch (consistent across all three platforms); menu = desktop menu accelerator. */
export type ShortcutChannel = "window" | "menu";

/** Command IDs for configurable shortcuts, one-to-one with SHORTCUT_COMMANDS. */
export type ShortcutCommandId =
  | "toggleInterfaceMode"
  | "openOnboarding"
  | "openCommandCenter"
  | "openSettings"
  | "findInTask"
  | "toggleSidebar"
  | "switchTheme"
  | "toggleTerminal"
  | "toggleSidePane"
  | "previousConversation"
  | "nextConversation"
  | "navigateBack"
  | "navigateForward"
  | "openModelMenu"
  | "cycleSessionMode"
  | "cycleThoughtLevel"
  | "newTask"
  | "openWorkspace"
  | "closeActiveContext"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "composerSend"
  | "composerInsertNewline"
  | "voiceDictation";

/**
 * Command scope: global = dispatched globally (useAppKeyboard / menu accelerator);
 * composer = consumed by the Lexical keyboard behavior plugin while the chat composer is focused, invisible to other dispatchers.
 * This lets Enter-family keys be registered safely because their effect is limited to the composer.
 */
export type ShortcutScope = "global" | "composer";

export interface ShortcutCommandEntry {
  readonly id: ShortcutCommandId;
  readonly channel: ShortcutChannel;
  /** Scope; defaults to global. */
  readonly scope?: ShortcutScope;
  /** Default bindings in canonical serialized form; multiple entries indicate multiple defaults and are replaced as a group when overridden. */
  readonly defaultBindings: readonly string[];
}

/**
 * Command table: the single source of truth for shortcut commands.
 * Note: navigateBack/navigateForward move through history; previousConversation/nextConversation
 * mean "previous/next task" (an early prototype mixed these up; this table is authoritative).
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommandEntry[] = [
  {
    id: "openCommandCenter",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"],
  },
  // Open Settings: macOS ⌘, / Windows·Linux Ctrl+, (a system convention, as in macOS Settings… and VS Code).
  { id: "openSettings", channel: "window", defaultBindings: ["CmdOrCtrl+,"] },
  { id: "findInTask", channel: "window", defaultBindings: ["CmdOrCtrl+f"] },
  { id: "toggleSidebar", channel: "window", defaultBindings: ["CmdOrCtrl+b"] },
  { id: "switchTheme", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+l"] },
  { id: "toggleTerminal", channel: "window", defaultBindings: ["CmdOrCtrl+j"] },
  { id: "toggleSidePane", channel: "window", defaultBindings: ["CmdOrCtrl+Alt+b"] },
  { id: "previousConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+["] },
  { id: "nextConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+]"] },
  { id: "navigateBack", channel: "window", defaultBindings: ["CmdOrCtrl+["] },
  { id: "navigateForward", channel: "window", defaultBindings: ["CmdOrCtrl+]"] },
  // Composer toolbar actions promoted from fixed shortcuts: explicitly use Ctrl (including on macOS,
  // matching the old matchesCtrlShortcut semantics); the toolbar's window capture listener consumes the active binding.
  { id: "openModelMenu", channel: "window", defaultBindings: ["Ctrl+m"] },
  { id: "cycleSessionMode", channel: "window", defaultBindings: ["Ctrl+Shift+m"] },
  { id: "cycleThoughtLevel", channel: "window", defaultBindings: ["Ctrl+t"] },
  { id: "newTask", channel: "menu", defaultBindings: ["CmdOrCtrl+n"] },
  { id: "openWorkspace", channel: "menu", defaultBindings: ["CmdOrCtrl+o"] },
  { id: "closeActiveContext", channel: "menu", defaultBindings: ["CmdOrCtrl+w"] },
  { id: "zoomIn", channel: "menu", defaultBindings: ["CmdOrCtrl+="] },
  { id: "zoomOut", channel: "menu", defaultBindings: ["CmdOrCtrl+-"] },
  { id: "resetZoom", channel: "menu", defaultBindings: ["CmdOrCtrl+0"] },
  // Composer scope: consumed by the input's Lexical plugin, not useAppKeyboard / menus.
  // channel is a type placeholder (renderer behavior); dispatchers identify it by scope.
  { id: "composerSend", channel: "window", scope: "composer", defaultBindings: ["Enter"] },
  {
    id: "composerInsertNewline",
    channel: "window",
    scope: "composer",
    defaultBindings: ["Shift+Enter"],
  },
  { id: "toggleInterfaceMode", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+u"] },
  { id: "openOnboarding", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+o"] },
  // Voice input: by default hold ⌘/Ctrl+Shift+D to record (in push-to-talk mode, releasing
  // transcribes), handled by the UI layer's keydown/keyup.
  // Note: the shortcut key-name allowlist does not include Space, so defaults like Option+Space
  // cannot be used.
  { id: "voiceDictation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+d"] },
];

/** Get default bindings by command ID; unknown commands return an empty array (resolve ignores unknown commands in the active table). */
export function getDefaultShortcutBindings(id: string): readonly string[] {
  return SHORTCUT_COMMANDS.find((entry) => entry.id === id)?.defaultBindings ?? [];
}

// ============================================================================
// Binding serialization format (Electron accelerator-compatible subset)
// ============================================================================

/** Parsed binding: modifier-key flags plus a normalized key name. */
export interface ParsedShortcutBinding {
  cmdOrCtrl: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  altGr: boolean;
  /** Normalized key name: lowercase letters, digits, symbols, or named keys (F1-F12, ArrowUp, etc.). */
  /** Normalized key name: lowercase letter / digit / symbol (= - [ ] , . / ; ' ` \) / named key (F1..F12, ArrowUp, etc.). */
  key: string;
}

/** Fixed modifier order when serializing. */
const MODIFIER_ORDER = [
  ["CmdOrCtrl", "cmdOrCtrl"],
  ["Ctrl", "ctrl"],
  ["Alt", "alt"],
  ["Shift", "shift"],
  ["AltGr", "altGr"],
] as const satisfies ReadonlyArray<readonly [string, keyof ParsedShortcutBinding]>;

/** Normalize menu-compatible aliases: Plus/Equal → "=", Minus → "-". */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  Plus: "=",
  Equal: "=",
  Minus: "-",
};

/** Single-character keys: lowercase letters, digits, and symbols. Uppercase letters are invalid (recording/serialization lowercases them). */
const SINGLE_CHAR_KEY = /^[a-z0-9[\]=\-,./;'\\`]$/;

/** Case-sensitive allowlist of named keys. Enter is used by composer-scoped commands. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "Insert",
  "Enter",
]);

/** Normalize a key name; return the normalized key if valid, otherwise null. */
export function normalizeShortcutKey(rawKey: string): string | null {
  const aliased = KEY_ALIASES[rawKey] ?? rawKey;
  if (SINGLE_CHAR_KEY.test(aliased)) {
    return aliased;
  }
  return NAMED_KEYS.has(aliased) ? aliased : null;
}

/**
 * Parse a binding string. Permissive: modifier order does not matter ("Shift+CmdOrCtrl+p" parses).
 * Strict: key names must be canonical (uppercase letters, bare "+", and unknown named keys are invalid); duplicate modifiers are invalid.
 */
export function parseShortcutBinding(binding: string): ParsedShortcutBinding | null {
  const tokens = binding.split("+");
  // The final token must be a key; "+" is not a valid key by itself (use "=" or the Plus alias), so an empty token from split is invalid.
  const keyToken = tokens[tokens.length - 1];
  if (keyToken === undefined || keyToken === "") {
    return null;
  }

  const parsed: ParsedShortcutBinding = {
    cmdOrCtrl: false,
    ctrl: false,
    alt: false,
    shift: false,
    altGr: false,
    key: "",
  };

  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_ORDER.find(([name]) => name === token);
    if (!modifier || parsed[modifier[1]]) {
      // Unknown modifiers (including Electron names such as Meta/Command) and duplicate modifiers are invalid.
      return null;
    }
    parsed[modifier[1]] = true;
  }

  const key = normalizeShortcutKey(keyToken);
  if (key === null) {
    return null;
  }
  parsed.key = key;
  return parsed;
}

/** Serialize in canonical form (fixed modifier order and canonical key name); return null if any part is invalid. */
export function serializeShortcutBinding(parsed: ParsedShortcutBinding): string | null {
  const key = normalizeShortcutKey(parsed.key);
  if (key === null) {
    return null;
  }

  const parts: string[] = [];
  for (const [name, field] of MODIFIER_ORDER) {
    if (parsed[field]) {
      parts.push(name);
    }
  }
  parts.push(key);
  return parts.join("+");
}

/** Whether a binding string is in valid canonical form (parsing and reserializing produces the original string). */
export function isValidShortcutBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  return parsed !== null && serializeShortcutBinding(parsed) === binding;
}
