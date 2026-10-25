import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "@zcode/shared";

test("unknown locale falls back without dropping other settings", () => {
  const parsed = appSettingsSchema.parse({
    locale: "xx-XX",
    localePreference: "xx-XX",
    recentProjects: ["/a"],
  });
  assert.deepEqual(parsed.recentProjects, ["/a"]);
  assert.equal(parsed.locale, "zh-CN");
  assert.equal(parsed.localePreference, "system");
});

test("unknown locale without preference keeps other settings", () => {
  const parsed = appSettingsSchema.parse({ locale: "xx-XX", recentProjects: ["/b"] });
  assert.deepEqual(parsed.recentProjects, ["/b"]);
  assert.equal(parsed.locale, "zh-CN");
  assert.equal(parsed.localePreference, "system");
});

test("supported locales pass through unchanged", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const parsed = appSettingsSchema.parse({ locale, localePreference: locale });
    assert.equal(parsed.locale, locale);
    assert.equal(parsed.localePreference, locale);
  }
  const system = appSettingsSchema.parse({ locale: "en-US", localePreference: "system" });
  assert.equal(system.localePreference, "system");
});

test("missing locale fields use defaults", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.locale, "zh-CN");
  assert.equal(parsed.localePreference, "system");
});

test("legacy locale-only settings keep the explicit preference", () => {
  const parsed = appSettingsSchema.parse({ locale: "en-US" });
  assert.equal(parsed.localePreference, "en-US");
});

test("pending release notes with an unknown locale key are dropped, settings kept", () => {
  const parsed = appSettingsSchema.parse({
    recentProjects: ["/c"],
    pendingPostUpdateReleaseNotes: {
      version: "1.0.0",
      title: "Title",
      markdown: "Body",
      releaseNotesByLocale: { "xx-XX": { title: "T", markdown: "M" } },
    },
  });
  assert.deepEqual(parsed.recentProjects, ["/c"]);
  assert.equal(parsed.pendingPostUpdateReleaseNotes, undefined);
});

test("valid pending release notes are preserved", () => {
  const notes = {
    version: "1.0.0",
    title: "Title",
    markdown: "Body",
    releaseNotesByLocale: { "en-US": { title: "T", markdown: "M" } },
  };
  const parsed = appSettingsSchema.parse({ pendingPostUpdateReleaseNotes: notes });
  assert.deepEqual(parsed.pendingPostUpdateReleaseNotes, notes);
});

test("patch schema still rejects unknown locales", () => {
  assert.equal(appSettingsPatchSchema.safeParse({ locale: "xx-XX" }).success, false);
  assert.equal(appSettingsPatchSchema.safeParse({ localePreference: "xx-XX" }).success, false);
  assert.equal(appSettingsPatchSchema.safeParse({ locale: "en-US" }).success, true);
});
