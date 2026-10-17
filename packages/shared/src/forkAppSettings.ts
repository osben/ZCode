import { z } from "zod";
import type { AppSettings } from "./protocol.js";

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
] as const satisfies readonly (keyof AppSettings)[];

export type ForkSettingKey = (typeof FORK_SETTING_KEYS)[number];

const voiceDictationSettingsSchema = z.object({
  modelId: nonEmptyStringSchema.nullable().optional(),
  microphoneDeviceId: nonEmptyStringSchema.nullable().optional(),
  language: nonEmptyStringSchema.optional(),
  pushToTalk: z.boolean().optional(),
  idleUnloadMinutes: z
    .union([z.literal(1), z.literal(5), z.literal(10), z.literal(15), z.literal(30)])
    .optional(),
  feedbackSounds: z.boolean().optional(),
  feedbackVolume: z.number().int().min(0).max(100).optional(),
  muteWhileRecording: z.boolean().optional(),
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
  voiceDictation: voiceDictationSettingsSchema.optional().catch(undefined),
  codingPlanLimitAutoContinueDefaultEnabled: z.boolean().optional().catch(undefined),
  worktreeLocationMode: worktreeLocationModeSchema.optional().catch(undefined),
  worktreeCustomLocationPath: nonEmptyStringSchema.optional().catch(undefined),
  worktreeBranchPrefix: nonEmptyStringSchema.optional().catch(undefined),
  worktreeProjectOverrides: z
    .record(z.string(), worktreeProjectOverrideSchema)
    .optional()
    .catch(undefined),
  memoryIndexAsContext: z.boolean().optional().catch(undefined),
});

export type ForkAppSettingsStored = z.infer<typeof forkAppSettingsStoredSchema>;

/** Effective view of the sidecar: stored values plus materialized defaults. Never persisted back. */
export const forkAppSettingsSchema = forkAppSettingsStoredSchema.extend({
  codingPlanLimitAutoContinueDefaultEnabled: z.boolean().default(true).catch(true),
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
});

/**
 * Split a normalized settings patch into the fork-owned part (routed to the sidecar file) and the
 * rest (persisted to `setting.json` exactly like the upstream-compatible schema expects).
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
