export interface KeyboardShortcutPlatformInfo {
  platform?: string;
  userAgent?: string;
}

interface PrimaryShortcutKeyboardEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function readNavigatorPlatformInfo(): KeyboardShortcutPlatformInfo {
  if (typeof navigator === "undefined") {
    return {};
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

export function isAppleKeyboardPlatform(
  platformInfo: KeyboardShortcutPlatformInfo = readNavigatorPlatformInfo(),
): boolean {
  const platform = platformInfo.platform?.toLowerCase() ?? "";
  const userAgent = platformInfo.userAgent ?? "";

  if (
    platform.includes("mac") ||
    platform.includes("iphone") ||
    platform.includes("ipad") ||
    platform.includes("ipod")
  ) {
    return true;
  }

  return /Mac|iPhone|iPad|iPod/.test(userAgent);
}

function getCommandModifierLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? "⌘" : "Ctrl";
}

function getCtrlModifierLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? "⌃" : "Ctrl";
}

function formatAppleShortcutLabel(...parts: string[]): string {
  return parts.join(" ");
}

export function formatCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const mod = getCommandModifierLabel(platformInfo);
  if (isAppleKeyboardPlatform(platformInfo)) {
    return formatAppleShortcutLabel(mod, formatShortcutKeyLabel(key));
  }
  return `${mod}+${key.toUpperCase()}`;
}

export function formatAltCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const command = getCommandModifierLabel(platformInfo);
  if (isApple) {
    return formatAppleShortcutLabel("⌥", command, formatShortcutKeyLabel(key));
  }
  return `Ctrl+Alt+${key.toUpperCase()}`;
}

export function formatShiftCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const command = getCommandModifierLabel(platformInfo);
  const displayKey = formatShortcutKeyLabel(key);
  if (isApple) {
    return formatAppleShortcutLabel("⇧", command, displayKey);
  }
  return `Ctrl+Shift+${displayKey}`;
}

function formatShortcutKeyLabel(key: string): string {
  switch (key) {
    case "[":
      return "[";
    case "]":
      return "]";
    default:
      return key.toUpperCase();
  }
}

export function matchesPrimaryShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

export function matchesPrimaryShiftShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

export function matchesPrimaryAltShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    !event.shiftKey &&
    event.altKey &&
    matchesShortcutKey(event, key)
  );
}

function matchesPrimaryModifier(
  event: PrimaryShortcutKeyboardEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  // Scope the primary modifier by platform. On macOS, Ctrl is reserved for system Emacs-style text editing;
  // use Ctrl on Windows/Linux. Ctrl and Command pressed together do not count as the primary modifier, preventing accidental triggers.
  return isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function matchesCtrlShortcut(event: PrimaryShortcutKeyboardEvent, key: string): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

export function matchesCtrlShiftShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

/**
 * Match the standalone Shift+Tab shortcut (without Ctrl/Cmd/Alt).
 * Chat-toolbar mode used this combination in the past; retain it for callers that still need to distinguish reverse Tab navigation.
 */
export function matchesShiftTab(event: PrimaryShortcutKeyboardEvent): boolean {
  return (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "Tab" || event.code === "Tab")
  );
}

export function formatShiftTabShortcutLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? formatAppleShortcutLabel("⇧", "Tab") : "Shift+Tab";
}

function matchesShortcutKey(
  event: Pick<PrimaryShortcutKeyboardEvent, "key" | "code">,
  key: string,
): boolean {
  const normalizedKey = key.toLowerCase();
  if (event.key.toLowerCase() === normalizedKey) {
    return true;
  }

  // Fix: on macOS, pressing Option in a shortcut can cause the current keyboard layout to change event.key,
  // so comparing key directly can miss shortcuts such as ⌥⌘B. Also match code to avoid input-method and layout effects.
  const expectedCode = getExpectedShortcutCode(normalizedKey);
  return expectedCode != null && event.code === expectedCode;
}

function getExpectedShortcutCode(key: string): string | null {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      return `Key${lower.toUpperCase()}`;
    }
    if (lower >= "0" && lower <= "9") {
      return `Digit${lower}`;
    }
  }

  switch (key) {
    case "[":
      return "BracketLeft";
    case "]":
      return "BracketRight";
    default:
      return null;
  }
}
