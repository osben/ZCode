export interface LocalBooleanPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

// Single implementation of the UI-local boolean preference pattern: "true" when enabled,
// key removed when disabled, anything else reads as disabled. Storage failures are best-effort.
export function getBrowserLocalStorage(): LocalBooleanPreferenceStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLocalBooleanPreference(
  key: string,
  storage: LocalBooleanPreferenceStorage | null = getBrowserLocalStorage(),
): boolean {
  try {
    return storage?.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function persistLocalBooleanPreference(
  key: string,
  enabled: boolean,
  storage: LocalBooleanPreferenceStorage | null = getBrowserLocalStorage(),
): void {
  try {
    if (enabled) {
      storage?.setItem(key, "true");
    } else {
      storage?.removeItem?.(key);
    }
  } catch {
    // Storage may be unavailable (private mode); the preference is best-effort.
  }
}
