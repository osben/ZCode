// Pure language/model helpers shared by the settings UI and tests. No Node or React dependencies:
// the renderer bundles this module through the services barrel.

/** The slice of a catalog descriptor these helpers need (structural so tests can use small fixtures). */
export interface VoiceModelLike {
  id: string;
  name: string;
  family: string;
  streaming: boolean;
  /** ISO 639-1 codes the model supports. */
  languages: readonly string[];
  /** Lower is recommended first; models without a rank are never recommended. */
  recommendRank?: number;
}

export interface VoiceModelItemLike {
  descriptor: VoiceModelLike;
  state: { status: string };
}

export interface VoiceLanguageSettingsLike {
  languages?: readonly string[];
  /** Legacy single language (`auto` means detection); kept as a mirror for older fork builds. */
  language?: string;
}

const AUTO = "auto";

function normalizeCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const code of codes) {
    const trimmed = code.trim();
    if (trimmed && trimmed !== AUTO) seen.add(trimmed);
  }
  return [...seen];
}

/** Selected dictation languages; empty means automatic detection. `languages` wins over the legacy `language`. */
export function resolveVoiceLanguages(settings: VoiceLanguageSettingsLike): string[] {
  if (settings.languages !== undefined) return normalizeCodes(settings.languages);
  return normalizeCodes(settings.language ? [settings.language] : []);
}

/**
 * The engine takes one language or none, so a list is never sent as a constraint: exactly one
 * selection is forced, zero or several are left to the model's automatic detection.
 */
export function engineLanguageFor(languages: readonly string[]): string {
  const normalized = normalizeCodes(languages);
  return normalized.length === 1 ? normalized[0]! : AUTO;
}

/** The language to send to the engine for a settings object (single selection forced, otherwise auto). */
export function resolveEngineLanguage(settings: VoiceLanguageSettingsLike): string {
  return engineLanguageFor(resolveVoiceLanguages(settings));
}

/** Settings patch that keeps `languages` and its legacy `language` mirror in sync in a single write. */
export function languageSettingsPatch(languages: readonly string[]): {
  languages: string[];
  language: string;
} {
  const normalized = normalizeCodes(languages);
  return { languages: normalized, language: normalized.length === 1 ? normalized[0]! : AUTO };
}

export function missingVoiceLanguages(
  model: VoiceModelLike,
  languages: readonly string[],
): string[] {
  return normalizeCodes(languages).filter((code) => !model.languages.includes(code));
}

export function modelSupportsVoiceLanguages(
  model: VoiceModelLike,
  languages: readonly string[],
): boolean {
  return missingVoiceLanguages(model, languages).length === 0;
}

/** Best-ranked model covering every selected language; null when nothing is selected or nothing qualifies. */
export function recommendVoiceModel<T extends VoiceModelLike>(
  catalog: readonly T[],
  languages: readonly string[],
): T | null {
  if (normalizeCodes(languages).length === 0) return null;
  let best: T | null = null;
  for (const candidate of catalog) {
    if (candidate.recommendRank === undefined) continue;
    if (!modelSupportsVoiceLanguages(candidate, languages)) continue;
    if (best === null || candidate.recommendRank < best.recommendRank!) best = candidate;
  }
  return best;
}

/**
 * Whether live (streaming) transcription really activates for the model. The catalog flag is set only
 * after a runtime check that the model streams with a family `selectStreamFamily` can choose.
 */
export function isLiveStreamingModel(model: Pick<VoiceModelLike, "streaming">): boolean {
  return model.streaming;
}

/**
 * Language handed to the native engine: models whose native layer rejects bare codes get their locale
 * (`uk` -> `uk-UA`); automatic detection (no language) and unmapped codes pass through unchanged.
 */
export function toNativeLanguage(
  model: { languageLocales?: Readonly<Record<string, string>> } | undefined,
  language: string | undefined,
): string | undefined {
  if (!language) return undefined;
  return model?.languageLocales?.[language] ?? language;
}

export interface VoiceModelFilter {
  query: string;
  languages: readonly string[];
  downloadedOnly: boolean;
  streamingOnly: boolean;
}

export function filterVoiceModels<T extends VoiceModelItemLike>(
  items: readonly T[],
  filter: VoiceModelFilter,
  languageName: (code: string) => string,
): T[] {
  const query = filter.query.trim().toLowerCase();
  return items.filter(({ descriptor, state }) => {
    if (filter.downloadedOnly && state.status !== "ready") return false;
    if (filter.streamingOnly && !isLiveStreamingModel(descriptor)) return false;
    if (!modelSupportsVoiceLanguages(descriptor, filter.languages)) return false;
    if (!query) return true;
    // Cheap fields first; the per-language names are only built when those do not match.
    if (`${descriptor.name}\n${descriptor.family}`.toLowerCase().includes(query)) return true;
    return descriptor.languages.some(
      (code) => code.includes(query) || languageName(code).toLowerCase().includes(query),
    );
  });
}

/**
 * Recommended model first, everything else in catalog order. Download state is deliberately not a
 * sort key: a card must not jump to another position when its download finishes.
 */
export function sortVoiceModels<T extends VoiceModelItemLike>(
  items: readonly T[],
  recommendedId: string | null,
): T[] {
  const recommended = items.filter((item) => item.descriptor.id === recommendedId);
  return [...recommended, ...items.filter((item) => item.descriptor.id !== recommendedId)];
}
