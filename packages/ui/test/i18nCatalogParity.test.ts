import assert from "node:assert/strict";
import { describe, it } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
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

  it("every plural family has an .other form", () => {
    for (const [name, catalog] of [
      ["en-US", enUS],
      ["zh-CN", zhCN],
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
