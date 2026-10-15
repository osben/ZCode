import { readSafeLocalStorage } from "@/lib/browserEnvironment.js";

/**
 * User-customizable font families.
 *
 * The default stacks live in the @theme block of styles.css. A custom font is applied as a
 * runtime override of --font-sans / --font-mono on documentElement (same mechanism as
 * --ui-font-size): the custom name is prepended to the default stack so missing glyphs still
 * fall through, and clearing the override (null) removes the property so the CSS default wins.
 */

export const UI_FONT_FAMILY_STORAGE_KEY = "zcode-ui-font-family";
export const MONO_FONT_FAMILY_STORAGE_KEY = "zcode-mono-font-family";

/** Families shipped in the bundle; offered first in the font picker. */
export const BUNDLED_FONT_FAMILIES = ["Inter Variable", "JetBrains Mono Variable"] as const;

export function isFontFamilyStale(
  value: string | null,
  installedFamilies: string[] | null,
): boolean {
  const normalizedValue = value?.toLowerCase();
  return Boolean(
    normalizedValue &&
    installedFamilies !== null &&
    !BUNDLED_FONT_FAMILIES.some((family) => family.toLowerCase() === normalizedValue) &&
    !installedFamilies.some((family) => family.toLowerCase() === normalizedValue),
  );
}

export const MAX_CUSTOM_FONT_FAMILY_LENGTH = 100;

/** Stack appended after a custom UI font; mirrors styles.css after the bundled name. */
const UI_FONT_FALLBACK_STACK =
  '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
/** Stack appended after a custom mono font; mirrors styles.css after the bundled name. */
const MONO_FONT_FALLBACK_STACK =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

/** Trim, strip quotes, and length-cap a user-provided family name; empty input means no override. */
export function normalizeCustomFontFamily(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const stripped = value.trim().replaceAll(/['"]/gu, "");
  if (stripped === "" || stripped.length > MAX_CUSTOM_FONT_FAMILY_LENGTH) {
    return null;
  }
  return stripped;
}

export function loadUiFontFamily(): string | null {
  return normalizeCustomFontFamily(readSafeLocalStorage(UI_FONT_FAMILY_STORAGE_KEY));
}

export function loadMonoFontFamily(): string | null {
  return normalizeCustomFontFamily(readSafeLocalStorage(MONO_FONT_FAMILY_STORAGE_KEY));
}

function applyFontFamilyOverride(
  cssPropertyName: string,
  customFamily: string | null,
  fallbackStack: string,
): void {
  const rootStyle = typeof document === "undefined" ? undefined : document.documentElement?.style;
  if (!rootStyle?.setProperty) {
    return;
  }
  if (customFamily) {
    rootStyle.setProperty(cssPropertyName, `"${customFamily}", ${fallbackStack}`);
  } else {
    rootStyle.removeProperty(cssPropertyName);
  }
}

export function applyUiFontFamily(customFamily: string | null): void {
  applyFontFamilyOverride(
    "--font-sans",
    normalizeCustomFontFamily(customFamily),
    UI_FONT_FALLBACK_STACK,
  );
}

export function applyMonoFontFamily(customFamily: string | null): void {
  applyFontFamilyOverride(
    "--font-mono",
    normalizeCustomFontFamily(customFamily),
    MONO_FONT_FALLBACK_STACK,
  );
}

/** Mono family stack for consumers that cannot read CSS variables (xterm.js). */
export function resolveTerminalFontFamily(options: {
  /** Appearance "code font" override; null/empty = bundled default. */
  customMonoFamily: string | null;
  /** Font resolved by terminalService.create (terminal setting, system profile, or fallback stack). */
  profileFontFamily: string | undefined;
  /** True when profileFontFamily came from the terminal-specific user setting, which outranks the appearance mono font. */
  profileFontIsCustom: boolean;
  /** True when terminalService supplied only its generic fallback stack. */
  profileFontIsFallback?: boolean;
  defaultStack: string;
}): string {
  const profileFontFamily = options.profileFontIsFallback ? undefined : options.profileFontFamily;
  if (options.profileFontIsCustom && profileFontFamily) {
    return profileFontFamily;
  }
  const mono = normalizeCustomFontFamily(options.customMonoFamily);
  if (mono) {
    return `"${mono}", ${profileFontFamily || options.defaultStack}`;
  }
  return profileFontFamily || options.defaultStack;
}

function subscribeToFontFamilyStorageChange(key: string, apply: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === key) {
      apply();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}

export function subscribeToUiFontFamilyStorageChanges(): () => void {
  return subscribeToFontFamilyStorageChange(UI_FONT_FAMILY_STORAGE_KEY, () =>
    applyUiFontFamily(loadUiFontFamily()),
  );
}

export function subscribeToMonoFontFamilyStorageChanges(): () => void {
  return subscribeToFontFamilyStorageChange(MONO_FONT_FAMILY_STORAGE_KEY, () =>
    applyMonoFontFamily(loadMonoFontFamily()),
  );
}

/** Minimal Local Font Access entry; full types are not in lib.dom for all TypeScript versions. */
export interface LocalFontData {
  family: string;
}

/** Local Font Access API guard (Chromium only); null when the renderer does not provide it. */
export function getQueryLocalFonts(): (() => Promise<LocalFontData[]>) | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
  return typeof candidate === "function" ? (candidate as () => Promise<LocalFontData[]>) : null;
}

/** Dedupe queryLocalFonts entries into trimmed, case-insensitively sorted family names. */
export function normalizeInstalledFontFamilies(fonts: LocalFontData[]): string[] {
  const byLowercaseFamily = new Map<string, string>();
  for (const font of fonts) {
    const family = typeof font?.family === "string" ? font.family.trim() : "";
    const key = family.toLowerCase();
    if (family && !byLowercaseFamily.has(key)) {
      byLowercaseFamily.set(key, family);
    }
  }
  return [...byLowercaseFamily.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}
