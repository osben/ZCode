import { z } from "zod";
import {
  incognitoDefaultsPatchSchema,
  incognitoDefaultsStoredSchema,
} from "./incognito-profile.js";
import { isLocale, isLocalePreference } from "./locale.js";
import type { AppSettings, Locale, LocalePreference } from "./protocol.js";

const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * Registry of fork-only app setting keys. The upstream app shares `~/.zcode/v2/setting.json` with
 * this fork and re-parses it through its own schema on every write, silently deleting any key it
 * does not know. Fork-owned settings therefore live in a separate sidecar file
 * (`fork-settings.json`, see the setting service) and must be listed here so the setting service
 * routes them away from `setting.json`. Never add a fork-only key directly to
 * `appSettingsObjectSchema` — it would be wiped by the next upstream write.
 */
export const FORK_SETTING_KEYS = [
  "voiceDictation",
  "codingPlanLimitAutoContinueDefaultEnabled",
  "worktreeLocationMode",
  "worktreeCustomLocationPath",
  "worktreeBranchPrefix",
  "worktreeProjectOverrides",
  "memoryIndexAsContext",
  "incognitoDefaults",
  "resourceTelemetryEnabled",
  "localePreferenceOverride",
  "localeOverride",
] as const satisfies readonly (keyof AppSettings)[];

export type ForkSettingKey = (typeof FORK_SETTING_KEYS)[number];

const voiceDictationSettingsSchema = z.object({
  modelId: nonEmptyStringSchema.nullable().optional(),
  microphoneDeviceId: nonEmptyStringSchema.nullable().optional(),
  language: nonEmptyStringSchema.optional(),
  languages: z.array(nonEmptyStringSchema).max(100).optional(),
  pushToTalk: z.boolean().optional(),
  idleUnloadMinutes: z
    .union([z.literal(1), z.literal(5), z.literal(10), z.literal(15), z.literal(30)])
    .optional(),
  feedbackSounds: z.boolean().optional(),
  feedbackVolume: z.number().int().min(0).max(100).optional(),
  muteWhileRecording: z.boolean().optional(),
  copyToClipboard: z.boolean().optional(),
  warmUpOnFocus: z.boolean().optional(),
  postProcessEnabled: z.boolean().optional(),
  postProcessProvider: z.enum(["apple-fm"]).optional(),
  postProcessPrompt: z.string().max(4000).optional(),
});

// Read tolerance: one malformed `languages` value drops only itself instead of the whole voiceDictation object.
const voiceDictationStoredSchema = voiceDictationSettingsSchema.extend({
  languages: voiceDictationSettingsSchema.shape.languages.catch(undefined),
  // A provider written by a newer build must only drop itself, not the whole voiceDictation object.
  postProcessProvider: voiceDictationSettingsSchema.shape.postProcessProvider.catch(undefined),
  // A prompt over the current limit (newer build or hand edit) falls back to the default prompt.
  postProcessPrompt: voiceDictationSettingsSchema.shape.postProcessPrompt.catch(undefined),
});

const worktreeLocationModeSchema = z.enum(["sibling", "inside", "global", "custom"]);
const worktreeProjectOverrideSchema = z.object({
  defaultBaseBranch: nonEmptyStringSchema.optional(),
  branchPrefix: nonEmptyStringSchema.optional(),
});

/**
 * What is physically stored in fork-settings.json: ONLY keys the user explicitly set. Defaults are
 * deliberately absent from this schema, so changing a default in a future build reaches everyone
 * who never touched the setting instead of staying pinned to the value their first write froze.
 * Read tolerance mirrors the main settings policy — a damaged value drops only itself instead of
 * failing the whole file.
 */
export const forkAppSettingsStoredSchema = z.object({
  voiceDictation: voiceDictationStoredSchema.optional().catch(undefined),
  codingPlanLimitAutoContinueDefaultEnabled: z.boolean().optional().catch(undefined),
  worktreeLocationMode: worktreeLocationModeSchema.optional().catch(undefined),
  worktreeCustomLocationPath: nonEmptyStringSchema.optional().catch(undefined),
  worktreeBranchPrefix: nonEmptyStringSchema.optional().catch(undefined),
  worktreeProjectOverrides: z
    .record(z.string(), worktreeProjectOverrideSchema)
    .optional()
    .catch(undefined),
  memoryIndexAsContext: z.boolean().optional().catch(undefined),
  incognitoDefaults: incognitoDefaultsStoredSchema.optional().catch(undefined),
  resourceTelemetryEnabled: z.boolean().optional().catch(undefined),
  // Only uk-UA is ever stored here; any other value is dropped on read (specs/fork-locale-storage.md).
  localePreferenceOverride: z.literal("uk-UA").optional().catch(undefined),
  localeOverride: z.literal("uk-UA").optional().catch(undefined),
});

export type ForkAppSettingsStored = z.infer<typeof forkAppSettingsStoredSchema>;

/** Effective view of the sidecar: stored values plus materialized defaults. Never persisted back. */
export const forkAppSettingsSchema = forkAppSettingsStoredSchema.extend({
  codingPlanLimitAutoContinueDefaultEnabled: z.boolean().default(true).catch(true),
  resourceTelemetryEnabled: z.boolean().default(false).catch(false),
});

export type ForkAppSettings = z.infer<typeof forkAppSettingsSchema>;

export const forkAppSettingsPatchSchema = z.object({
  voiceDictation: voiceDictationSettingsSchema.optional(),
  codingPlanLimitAutoContinueDefaultEnabled: z.boolean().optional(),
  worktreeLocationMode: worktreeLocationModeSchema.optional(),
  worktreeCustomLocationPath: nonEmptyStringSchema.optional(),
  worktreeBranchPrefix: nonEmptyStringSchema.optional(),
  worktreeProjectOverrides: z.record(z.string(), worktreeProjectOverrideSchema).optional(),
  memoryIndexAsContext: z.boolean().optional(),
  incognitoDefaults: incognitoDefaultsPatchSchema.optional(),
  resourceTelemetryEnabled: z.boolean().optional(),
  localePreferenceOverride: z.literal("uk-UA").optional(),
  localeOverride: z.literal("uk-UA").optional(),
});

/**
 * Split a normalized settings patch into the fork-owned part (routed to the sidecar file) and the
 * rest (persisted to `setting.json` exactly like the upstream-compatible schema expects).
 * The locale pair is split by splitLocaleSettings: uk-UA becomes fork overrides, and the shared
 * keys always receive upstream-valid values (specs/fork-locale-storage.md).
 */
export function splitForkSettingsPatch(patch: Partial<AppSettings>): {
  forkPatch: Partial<ForkAppSettings>;
  basePatch: Partial<AppSettings>;
} {
  const forkPatch: Record<string, unknown> = {};
  const basePatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if ((FORK_SETTING_KEYS as readonly string[]).includes(key)) {
      forkPatch[key] = value;
    } else {
      basePatch[key] = value;
    }
  }
  if (patch.locale !== undefined || patch.localePreference !== undefined) {
    const localeSplit = splitLocaleSettings({
      locale: patch.locale,
      localePreference: patch.localePreference,
    });
    Object.assign(forkPatch, localeSplit.forkPatch);
    delete basePatch.locale;
    delete basePatch.localePreference;
    Object.assign(basePatch, localeSplit.sharedPatch);
  }
  return {
    forkPatch: forkPatch as Partial<ForkAppSettings>,
    basePatch: basePatch as Partial<AppSettings>,
  };
}

/** Extract fork-owned keys from a raw parsed `setting.json` object (used by the one-time migration). */
export function pickForkSettings(source: Record<string, unknown>): Partial<ForkAppSettings> {
  const picked: Record<string, unknown> = {};
  for (const key of FORK_SETTING_KEYS) {
    if (key in source) {
      picked[key] = source[key];
    }
  }
  return picked as Partial<ForkAppSettings>;
}

/**
 * Pull the fork keys out of a raw (unparsed) `setting.json` value, or undefined when the file has
 * none. The parsed schema output can never carry them (the keys are absent from the schema), so
 * the raw object is the only place a pre-migration fork key can still be seen.
 */
export function extractLegacyForkSettings(rawValue: unknown): Partial<ForkAppSettings> | undefined {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return undefined;
  }
  const legacy = pickForkSettings(rawValue as Record<string, unknown>);
  return Object.keys(legacy).length > 0 ? legacy : undefined;
}

/**
 * Pure rules for storing the fork's Ukrainian choice (ISSUE-045, specs/fork-locale-storage.md).
 * The shared `setting.json` keys stay within what the upstream app can read; uk-UA lives only in
 * the fork sidecar as one of two override keys. settingService is the only caller.
 */

/** Values the upstream app accepts for the shared `locale` key. */
export type SharedLocale = "zh-CN" | "en-US";

/** Values the upstream app accepts for the shared `localePreference` key. */
export type SharedLocalePreference = "system" | SharedLocale;

/** The only Ukrainian marker the fork stores in fork-settings.json. */
const FORK_UK_LOCALE = "uk-UA" as const;

/**
 * Upstream-valid stand-in written to the shared keys while Ukrainian is active. Matches uk-UA's
 * serviceLocale (packages/shared/src/locale.ts), so bots and services see the same fallback.
 */
const SHARED_FALLBACK_LOCALE: SharedLocale = "en-US";

export interface LocaleOverrides {
  /** The user's preference is Українська. */
  localePreferenceOverride?: "uk-UA";
  /** The resolved language is Українська (set by the preference, or by system resolution). */
  localeOverride?: "uk-UA";
}

export interface LocaleSplit {
  forkPatch: LocaleOverrides;
  sharedPatch: { locale?: SharedLocale; localePreference?: SharedLocalePreference };
}

export interface LegacyLocaleMigrationPlan extends LocaleSplit {
  forkPatch: LocaleOverrides;
  sharedPatch: { locale: SharedLocale; localePreference: SharedLocalePreference };
}

function toSharedLocale(locale: Locale): SharedLocale {
  return locale === FORK_UK_LOCALE ? SHARED_FALLBACK_LOCALE : locale;
}

/**
 * Split a normalized locale patch into the fork overrides and the upstream-valid shared values.
 * An absent `locale` leaves the shared locale untouched; a fixed or system preference clears the
 * preference override and keeps only a locale override when the resolved language is Ukrainian.
 */
export function splitLocaleSettings(input: {
  locale?: Locale;
  localePreference?: LocalePreference;
}): LocaleSplit {
  // Mirrors normalizeSettingsPatch: a locale-only patch is an explicit fixed-language choice.
  const preference = input.localePreference ?? input.locale;
  if (preference === undefined) {
    return { forkPatch: {}, sharedPatch: {} };
  }

  if (preference === FORK_UK_LOCALE) {
    // Shared keys become upstream-valid; the fork carries the actual choice.
    return {
      forkPatch: { localePreferenceOverride: FORK_UK_LOCALE, localeOverride: FORK_UK_LOCALE },
      sharedPatch: { locale: SHARED_FALLBACK_LOCALE, localePreference: "system" },
    };
  }

  // Explicit keys with undefined values clear the override in the sidecar (JSON drops them).
  return {
    forkPatch: {
      localePreferenceOverride: undefined,
      localeOverride: input.locale === FORK_UK_LOCALE ? FORK_UK_LOCALE : undefined,
    },
    sharedPatch: {
      localePreference: preference,
      ...(input.locale !== undefined ? { locale: toSharedLocale(input.locale) } : {}),
    },
  };
}

/**
 * Effective view: override first, then shared. Owner of the resolution rule; the settings service
 * applies it once in get(), and no other code path computes the effective locale.
 */
export function resolveEffectiveLocale(
  shared: { locale: Locale; localePreference?: LocalePreference },
  overrides: LocaleOverrides,
): { locale: Locale; localePreference: LocalePreference } {
  return {
    // An absent shared preference means the schema default, "system".
    localePreference: overrides.localePreferenceOverride ?? shared.localePreference ?? "system",
    locale: overrides.localeOverride ?? overrides.localePreferenceOverride ?? shared.locale,
  };
}

/**
 * One-time migration plan for a raw setting.json written by the earlier fork build. Returns
 * undefined unless a locale key holds uk-UA. The raw `localePreference` falls back to `locale`
 * when absent, the same rule as migrateLegacyLocalePreference, so a locale-only file migrates too.
 */
export function planLegacyLocaleMigration(raw: unknown): LegacyLocaleMigrationPlan | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const rawLocale = record.locale;
  const rawPreference = "localePreference" in record ? record.localePreference : record.locale;
  if (rawLocale !== FORK_UK_LOCALE && rawPreference !== FORK_UK_LOCALE) {
    return undefined;
  }
  const split = splitLocaleSettings({
    locale: isLocale(rawLocale) ? rawLocale : undefined,
    localePreference: isLocalePreference(rawPreference) ? rawPreference : undefined,
  });
  // splitLocaleSettings always writes both shared keys for a uk-UA input, so the plan is complete.
  return split as LegacyLocaleMigrationPlan;
}
