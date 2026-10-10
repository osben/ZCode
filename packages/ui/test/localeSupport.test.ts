import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LOCALE,
  FALLBACK_UI_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
  isLocalePreference,
  matchSupportedLocale,
  resolveSystemLocale,
  toServiceLocale,
} from "@zcode/shared";

describe("matchSupportedLocale", () => {
  it("maps any Chinese tag to zh-CN", () => {
    for (const tag of ["zh", "zh-TW", "zh_CN.UTF-8", "ZH-hans-CN"]) {
      assert.equal(matchSupportedLocale(tag), "zh-CN", tag);
    }
  });

  it("maps English tags to en-US", () => {
    assert.equal(matchSupportedLocale("en-GB"), "en-US");
    assert.equal(matchSupportedLocale("en_US.UTF-8"), "en-US");
  });

  it("returns null for unsupported or empty tags", () => {
    for (const tag of ["ru-RU", "xx-XX", "C", "", null, undefined]) {
      assert.equal(matchSupportedLocale(tag), null, String(tag));
    }
  });
});

describe("resolveSystemLocale", () => {
  it("falls back to DEFAULT_LOCALE for an empty tag by default", () => {
    assert.equal(resolveSystemLocale(""), DEFAULT_LOCALE);
    assert.equal(resolveSystemLocale(null), DEFAULT_LOCALE);
  });

  it("honours an explicit empty fallback", () => {
    assert.equal(resolveSystemLocale("", FALLBACK_UI_LOCALE), "en-US");
  });

  it("falls back to en-US for unknown languages", () => {
    assert.equal(resolveSystemLocale("de"), "en-US");
    assert.equal(resolveSystemLocale("xx-XX"), "en-US");
  });

  it("keeps supported languages", () => {
    assert.equal(resolveSystemLocale("zh-Hant"), "zh-CN");
    assert.equal(resolveSystemLocale("en-AU"), "en-US");
  });
});

describe("toServiceLocale", () => {
  it("maps every supported locale to zh-CN or en-US", () => {
    assert.equal(toServiceLocale("zh-CN"), "zh-CN");
    assert.equal(toServiceLocale("en-US"), "en-US");
    for (const locale of SUPPORTED_LOCALES) {
      assert.ok(["zh-CN", "en-US"].includes(toServiceLocale(locale)), locale);
    }
  });
});

describe("isLocale / isLocalePreference", () => {
  it("accepts only supported locales", () => {
    for (const locale of SUPPORTED_LOCALES) {
      assert.equal(isLocale(locale), true, locale);
    }
    for (const value of ["xx-XX", "system", "", "toString", null, 1]) {
      assert.equal(isLocale(value), false, String(value));
    }
  });

  it("accepts system as a preference", () => {
    assert.equal(isLocalePreference("system"), true);
    assert.equal(isLocalePreference("en-US"), true);
    assert.equal(isLocalePreference("xx-XX"), false);
  });
});
