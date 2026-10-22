import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  forkAppSettingsStoredSchema,
  planLegacyLocaleMigration,
  resolveEffectiveLocale,
  splitLocaleSettings,
} from "../src/forkAppSettings.js";
import type { Locale, LocalePreference } from "../src/protocol.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

// Literal copies of the upstream app's enums. Deliberately NOT imported from the fork's schema,
// so a fork-side change to the shared schema cannot make this check pass by accident.
const upstreamLocaleEnum = z.enum(["zh-CN", "en-US"]);
const upstreamLocalePreferenceEnum = z.enum(["system", "zh-CN", "en-US"]);
const upstreamSettingsKeys = z
  .object({ locale: upstreamLocaleEnum, localePreference: upstreamLocalePreferenceEnum })
  .partial()
  .strict();

const ALL_LOCALES: Locale[] = ["zh-CN", "en-US", "uk-UA"];
const ALL_PREFERENCES: LocalePreference[] = ["system", "zh-CN", "en-US", "uk-UA"];

describe("fork locale storage rules", () => {
  it("stores a Ukrainian preference only as fork overrides and writes upstream values to shared keys", () => {
    const split = splitLocaleSettings({ locale: "uk-UA", localePreference: "uk-UA" });

    expect(split.forkPatch).toEqual({ localePreferenceOverride: "uk-UA", localeOverride: "uk-UA" });
    expect(split.sharedPatch).toEqual({ locale: "en-US", localePreference: "system" });
  });

  it("keeps only the locale override when system resolves to Ukrainian", () => {
    const split = splitLocaleSettings({ locale: "uk-UA", localePreference: "system" });

    expect(split.forkPatch.localeOverride).toBe("uk-UA");
    expect(split.forkPatch.localePreferenceOverride).toBeUndefined();
    expect(split.sharedPatch).toEqual({ locale: "en-US", localePreference: "system" });
  });

  it.each([
    ["zh-CN", "zh-CN"],
    ["en-US", "en-US"],
    ["en-US", "system"],
    ["zh-CN", "system"],
  ] as const)(
    "clears both fork overrides when the user picks a fixed or system preference (locale=%s, preference=%s)",
    (locale, localePreference) => {
      const split = splitLocaleSettings({ locale, localePreference });

      expect(split.forkPatch.localePreferenceOverride).toBeUndefined();
      expect(split.forkPatch.localeOverride).toBeUndefined();
      expect(split.forkPatch).toHaveProperty("localePreferenceOverride");
      expect(split.forkPatch).toHaveProperty("localeOverride");
      expect(split.sharedPatch).toEqual({ locale, localePreference });
    },
  );

  it("never produces a shared value outside the upstream enums, for every input combination", () => {
    for (const locale of ALL_LOCALES) {
      for (const localePreference of ALL_PREFERENCES) {
        const split = splitLocaleSettings({ locale, localePreference });
        expect(upstreamSettingsKeys.safeParse(split.sharedPatch).success).toBe(true);
        for (const value of Object.values(split.forkPatch)) {
          expect([undefined, "uk-UA"]).toContain(value);
        }
      }
    }
  });

  it("writes only the preference to shared keys when the patch carries no locale", () => {
    const split = splitLocaleSettings({ localePreference: "en-US" });

    expect(split.sharedPatch).toEqual({ localePreference: "en-US" });
    expect(split.forkPatch.localePreferenceOverride).toBeUndefined();
  });

  it("resolves the effective locale as override first, then shared", () => {
    const shared = { locale: "en-US" as const, localePreference: "en-US" as const };

    expect(resolveEffectiveLocale(shared, {})).toEqual({
      locale: "en-US",
      localePreference: "en-US",
    });
    expect(
      resolveEffectiveLocale(shared, {
        localePreferenceOverride: "uk-UA",
        localeOverride: "uk-UA",
      }),
    ).toEqual({ locale: "uk-UA", localePreference: "uk-UA" });
    expect(
      resolveEffectiveLocale(
        { locale: "zh-CN", localePreference: "system" },
        { localeOverride: "uk-UA" },
      ),
    ).toEqual({ locale: "uk-UA", localePreference: "system" });
  });

  it("does not migrate a file whose locale keys already hold upstream values", () => {
    expect(
      planLegacyLocaleMigration({ locale: "zh-CN", localePreference: "system", other: 1 }),
    ).toBeUndefined();
    expect(planLegacyLocaleMigration({ recentProjects: [] })).toBeUndefined();
    expect(planLegacyLocaleMigration("not an object")).toBeUndefined();
  });

  it.each([
    ["both keys uk-UA", { locale: "uk-UA", localePreference: "uk-UA" }],
    ["locale-only uk-UA (pre-preference file)", { locale: "uk-UA" }],
    ["preference-only uk-UA", { localePreference: "uk-UA" }],
  ])("plans a one-time migration for %s", (_name, raw) => {
    const plan = planLegacyLocaleMigration(raw);

    expect(plan).toBeDefined();
    expect(plan?.forkPatch.localePreferenceOverride).toBe("uk-UA");
    expect(plan?.forkPatch.localeOverride).toBe("uk-UA");
    expect(plan?.sharedPatch).toEqual({ locale: "en-US", localePreference: "system" });
  });

  it("plans a locale-only override for a system preference with Ukrainian resolved language", () => {
    const plan = planLegacyLocaleMigration({ locale: "uk-UA", localePreference: "system" });

    expect(plan?.forkPatch.localePreferenceOverride).toBeUndefined();
    expect(plan?.forkPatch.localeOverride).toBe("uk-UA");
    expect(plan?.sharedPatch).toEqual({ locale: "en-US", localePreference: "system" });
  });

  it("is idempotent: applying the planned shared patch leaves nothing to migrate", () => {
    const raw = { locale: "uk-UA", localePreference: "uk-UA", recentProjects: ["/p"] };
    const plan = planLegacyLocaleMigration(raw);
    expect(plan).toBeDefined();

    const rewritten = { ...raw, ...plan?.sharedPatch };
    expect(planLegacyLocaleMigration(rewritten)).toBeUndefined();
    expect(rewritten.recentProjects).toEqual(["/p"]);
  });
});

describe("upstream compatibility of the shared settings schema", () => {
  it("rejects uk-UA in the persisted patch schema", () => {
    expect(appSettingsPatchSchema.safeParse({ locale: "uk-UA" }).success).toBe(false);
    expect(appSettingsPatchSchema.safeParse({ localePreference: "uk-UA" }).success).toBe(false);
  });

  it("never returns uk-UA from the persisted object schema, even for a legacy uk-UA value", () => {
    const parsed = appSettingsSchema.parse({ locale: "uk-UA", localePreference: "uk-UA" });

    expect(upstreamLocaleEnum.safeParse(parsed.locale).success).toBe(true);
    expect(upstreamLocalePreferenceEnum.safeParse(parsed.localePreference).success).toBe(true);
  });

  it("keeps fork override values restricted to uk-UA or absent", () => {
    expect(
      forkAppSettingsStoredSchema.parse({ localeOverride: "en-US" }).localeOverride,
    ).toBeUndefined();
    expect(
      forkAppSettingsStoredSchema.parse({ localePreferenceOverride: "uk-UA" })
        .localePreferenceOverride,
    ).toBe("uk-UA");
  });
});
