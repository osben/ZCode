/** User font-family overrides as a store slice (specs/fonts.md). Extracted from store/index.ts to keep the main store module small. */
import type { BroadcastMessage } from "@zcode/services";
import { writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  applyMonoFontFamily,
  applyUiFontFamily,
  loadMonoFontFamily,
  loadUiFontFamily,
  MONO_FONT_FAMILY_STORAGE_KEY,
  normalizeCustomFontFamily,
  UI_FONT_FAMILY_STORAGE_KEY,
} from "@/lib/uiFonts.js";

export interface FontPreferencesState {
  /** Custom UI font family override; null = bundled default. */
  uiFontFamily: string | null;
  setUiFontFamily: (value: string | null) => void;
  /** Custom mono font family override for code, diffs and terminal; null = bundled default. */
  monoFontFamily: string | null;
  setMonoFontFamily: (value: string | null) => void;
}

export function createFontPreferencesSlice(
  set: (partial: Partial<FontPreferencesState>) => void,
): FontPreferencesState {
  return {
    uiFontFamily: loadUiFontFamily(),
    setUiFontFamily: (value: string | null) => {
      const fontFamily = normalizeCustomFontFamily(value);
      writeSafeLocalStorage(UI_FONT_FAMILY_STORAGE_KEY, fontFamily ?? "");
      applyUiFontFamily(fontFamily);
      set({ uiFontFamily: fontFamily });
    },
    monoFontFamily: loadMonoFontFamily(),
    setMonoFontFamily: (value: string | null) => {
      const fontFamily = normalizeCustomFontFamily(value);
      writeSafeLocalStorage(MONO_FONT_FAMILY_STORAGE_KEY, fontFamily ?? "");
      applyMonoFontFamily(fontFamily);
      set({ monoFontFamily: fontFamily });
    },
  };
}

/** Apply a broadcast update for this slice's fields; returns false when the message is not a font-preferences field. */
export function applyFontPreferencesBroadcast(
  state: FontPreferencesState,
  message: BroadcastMessage,
  fieldName: string,
): boolean {
  if (fieldName !== "uiFontFamily" && fieldName !== "monoFontFamily") {
    return false;
  }
  const payload: unknown = message.payload;
  if (payload !== null && typeof payload !== "string") {
    return true;
  }
  if (fieldName === "uiFontFamily") {
    state.setUiFontFamily(payload);
  } else {
    state.setMonoFontFamily(payload);
  }
  return true;
}

/** Re-apply the persisted overrides on window startup (called where the store is created). */
export function applyPersistedFontPreferences(state: FontPreferencesState): void {
  applyUiFontFamily(state.uiFontFamily);
  applyMonoFontFamily(state.monoFontFamily);
}
