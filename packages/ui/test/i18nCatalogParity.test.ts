import assert from "node:assert/strict";
import { describe, it } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import ukUA from "../src/i18n/locales/uk-UA.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// Keys present in en but missing from zh: the settings key is an existing locale exception;
// English needs a singular form for these plural families while Chinese uses only `.other`.
const EN_ONLY_KEYS = [
  "settings.memory.viewer.disabled",
  "taskList.childSideChatsCount.one",
  "taskList.childSubagentsCount.one",
  "taskList.childSubagentsRunningCount.one",
];

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

function placeholders(message: string): Set<string> {
  return new Set([...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!));
}

function htmlTags(message: string): string[] {
  return [...message.matchAll(/<\/?([a-zA-Z][\w-]*)[^>]*>/g)].map((match) => match[0]!).sort();
}

function boldMarkers(message: string): number {
  return message.split("**").length - 1;
}

const UK_PLURAL_CATEGORIES = ["one", "few", "many", "other"];

function pluralBaseOf(key: string): string | undefined {
  return key.match(/^(.*)\.(?:zero|one|two|few|many|other)$/)?.[1];
}

// The `.few` / `.many` forms in uk do not exist in en, so compare them with en `.other`.
function enReference(key: string): string | undefined {
  const direct = enUS[key];
  if (direct !== undefined) return direct;
  const base = pluralBaseOf(key);
  return base === undefined || enUS[`${base}.one`] === undefined
    ? undefined
    : enUS[`${base}.other`];
}

describe("i18n catalog parity", () => {
  it("en and zh share the same keys except the exact allowlist", () => {
    const enKeys = new Set(Object.keys(enUS));
    const zhKeys = new Set(Object.keys(zhCN));
    const enOnly = [...enKeys].filter((key) => !zhKeys.has(key)).sort();
    const zhOnly = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
    assert.deepEqual(enOnly, [...EN_ONLY_KEYS].sort());
    assert.deepEqual(zhOnly, []);
  });

  it("zh placeholders are a subset of en placeholders", () => {
    for (const [key, zh] of Object.entries(zhCN)) {
      const en = enUS[key];
      if (en === undefined) continue;
      const enNames = placeholders(en);
      // Every plural form may include {count}: en `.one` is often the literal "1 file", so compare against en `.other` too.
      const pluralBase = key.match(/^(.*)\.(?:zero|one|two|few|many|other)$/)?.[1];
      const enOther = pluralBase === undefined ? undefined : enUS[`${pluralBase}.other`];
      if (enOther !== undefined) {
        for (const name of placeholders(enOther)) enNames.add(name);
      }
      for (const name of placeholders(zh)) {
        assert.ok(enNames.has(name), `${key}: {${name}} not in en`);
      }
    }
  });

  it("zh keeps en HTML tags and bold markers", () => {
    for (const [key, zh] of Object.entries(zhCN)) {
      const en = enUS[key];
      if (en === undefined) continue;
      assert.deepEqual(htmlTags(zh), htmlTags(en), `${key}: HTML tags differ`);
      assert.equal(boldMarkers(zh), boldMarkers(en), `${key}: ** count differs`);
    }
  });

  it("uk keys are en keys or uk plural forms of en plural families", () => {
    for (const key of Object.keys(ukUA)) {
      assert.ok(enReference(key) !== undefined, `uk-UA: ${key} not in en`);
    }
  });

  it("uk placeholders, HTML tags and bold markers match en", () => {
    for (const [key, uk] of Object.entries(ukUA)) {
      const en = enReference(key);
      if (en === undefined) continue;
      const enNames = placeholders(en);
      const base = pluralBaseOf(key);
      const enOther = base === undefined ? undefined : enUS[`${base}.other`];
      if (enOther !== undefined) {
        for (const name of placeholders(enOther)) enNames.add(name);
      }
      for (const name of placeholders(uk)) {
        assert.ok(enNames.has(name), `uk-UA ${key}: {${name}} not in en`);
      }
      assert.deepEqual(htmlTags(uk), htmlTags(en), `uk-UA ${key}: HTML tags differ`);
      assert.equal(boldMarkers(uk), boldMarkers(en), `uk-UA ${key}: ** count differs`);
    }
  });

  it("translated uk plural families have one/few/many/other with {count}", () => {
    const families = new Set(
      Object.keys(ukUA)
        .map(pluralBaseOf)
        // Only keys with an en `.one` are plural families; `feedback.module.other` and similar keys are ordinary "other" copy.
        .filter((base): base is string => base !== undefined && enUS[`${base}.one`] !== undefined),
    );
    for (const base of families) {
      // Ukrainian `one` also covers 21, 31, etc., so every form must include {count} when en `.other` does.
      const needsCount = placeholders(enUS[`${base}.other`]!).has("count");
      for (const category of UK_PLURAL_CATEGORIES) {
        const message = ukUA[`${base}.${category}`];
        assert.ok(message !== undefined, `uk-UA: ${base} lacks .${category}`);
        if (needsCount) {
          assert.ok(message.includes("{count}"), `uk-UA: ${base}.${category} lacks {count}`);
        }
      }
    }
  });

  it("uk catalog is complete: every en key, with one/few/many/other for plural families", () => {
    const missing: string[] = [];
    for (const key of Object.keys(enUS)) {
      if (EN_ONLY_KEYS.includes(key)) continue;
      const base = pluralBaseOf(key);
      const expected =
        base !== undefined && enUS[`${base}.one`] !== undefined
          ? UK_PLURAL_CATEGORIES.map((category) => `${base}.${category}`)
          : [key];
      for (const ukKey of expected) {
        if (ukUA[ukKey] === undefined && !missing.includes(ukKey)) missing.push(ukKey);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("uk text has no Russian letters and uses the ASCII apostrophe", () => {
    for (const [key, uk] of Object.entries(ukUA)) {
      assert.doesNotMatch(uk, /[ыэъёЫЭЪЁ]/, `uk-UA ${key}: Russian letter`);
      assert.doesNotMatch(uk, /[’ʼ]/, `uk-UA ${key}: use the ASCII apostrophe '`);
    }
  });

  it("reports uk labels much longer than en (visual check list, not a failure)", (t) => {
    const long = Object.entries(ukUA)
      .filter(([key, uk]) => {
        const en = enReference(key);
        return (
          en !== undefined &&
          /button|tab|menu|action|title/i.test(key) &&
          uk.length > en.length * 1.5 &&
          uk.length - en.length > 4
        );
      })
      .map(([key]) => key);
    if (long.length > 0) t.diagnostic(`uk-UA long labels (${long.length}): ${long.join(", ")}`);
  });

  it("every plural family has an .other form", () => {
    for (const [name, catalog] of [
      ["en-US", enUS],
      ["zh-CN", zhCN],
      ["uk-UA", ukUA],
    ] as const) {
      for (const key of Object.keys(catalog)) {
        const category = PLURAL_CATEGORIES.find(
          (candidate) => candidate !== "other" && key.endsWith(`.${candidate}`),
        );
        if (category === undefined) continue;
        const base = key.slice(0, -(category.length + 1));
        assert.ok(catalog[`${base}.other`] !== undefined, `${name}: ${base} lacks .other`);
      }
    }
  });
});
