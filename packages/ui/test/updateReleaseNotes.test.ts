import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Locale, PostUpdateReleaseNotesPayload } from "@zcode/shared";
import { getLocalizedUpdateReleaseNotes } from "../src/updateReleaseNotes.js";

const zh = { title: "中文标题", markdown: "中文" };
const en = { title: "English title", markdown: "English" };

function payload(
  releaseNotesByLocale?: PostUpdateReleaseNotesPayload["releaseNotesByLocale"],
): PostUpdateReleaseNotesPayload {
  return {
    version: "1.2.3",
    title: "默认标题",
    markdown: "默认",
    ...(releaseNotesByLocale ? { releaseNotesByLocale } : {}),
  } as PostUpdateReleaseNotesPayload;
}

const defaults = { title: "默认标题", markdown: "默认" };
// Before I3, the new language is not yet in the Locale union type, so simulate it in the test with a type assertion.
const otherLocale = "xx-XX" as Locale;

describe("getLocalizedUpdateReleaseNotes", () => {
  it("returns null without payload", () => {
    assert.equal(getLocalizedUpdateReleaseNotes(undefined, "en-US"), null);
  });

  it("prefers the exact locale", () => {
    const value = payload({ "zh-CN": zh, "en-US": en });
    assert.deepEqual(getLocalizedUpdateReleaseNotes(value, "en-US"), en);
    assert.deepEqual(getLocalizedUpdateReleaseNotes(value, "zh-CN"), zh);
  });

  it("zh-CN falls back to the default notes", () => {
    assert.deepEqual(getLocalizedUpdateReleaseNotes(payload({ "en-US": en }), "zh-CN"), defaults);
  });

  it("en-US keeps the zh-CN → default fallback", () => {
    assert.deepEqual(getLocalizedUpdateReleaseNotes(payload({ "zh-CN": zh }), "en-US"), zh);
    assert.deepEqual(getLocalizedUpdateReleaseNotes(payload(), "en-US"), defaults);
  });

  it("other locales fall back to en-US, then default, never zh-CN", () => {
    assert.deepEqual(
      getLocalizedUpdateReleaseNotes(payload({ "zh-CN": zh, "en-US": en }), otherLocale),
      en,
    );
    assert.deepEqual(
      getLocalizedUpdateReleaseNotes(payload({ "zh-CN": zh }), otherLocale),
      defaults,
    );
  });
});
