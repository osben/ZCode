import assert from "node:assert/strict";
import { describe, it } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import ukUA from "../src/i18n/locales/uk-UA.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// en 有而 zh 没有的 key：精确名单，过期条目同样让测试失败。
const EN_ONLY_KEYS = ["settings.memory.viewer.disabled"];

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

// uk 的 `.few` / `.many` 在 en 中不存在，按 en `.other` 对照。
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
      // 复数族的各形态都可以带 {count}：en 的 `.one` 常写成字面量「1 file」，所以同时对照 en `.other`。
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
        // 只有 en 同时有 `.one` 的才是复数族；`feedback.module.other` 之类是普通「其他」文案。
        .filter((base): base is string => base !== undefined && enUS[`${base}.one`] !== undefined),
    );
    for (const base of families) {
      // uk 的 `one` 同时覆盖 21、31…，所以 en `.other` 带 {count} 时每个形态都必须带 {count}。
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
