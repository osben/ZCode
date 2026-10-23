import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Locale } from "@zcode/shared";
import { createIntl } from "../src/i18n/createIntl.js";
import enUS from "../src/i18n/locales/en-US.js";
import ukUA from "../src/i18n/locales/uk-UA.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const COUNTS = [0, 1, 2, 5, 21];
// The `.one` form is never selected for zh (Intl.PluralRules("zh-CN") returns other even for 1), so this message intentionally changes when count=1.
const ZH_KNOWN_ONE_CHANGES = new Set(["chat.toolCall.workflow.getRun.health.leftover"]);

function pluralFamilies(catalog: Record<string, string>): string[] {
  return Object.keys(catalog)
    .filter((key) => key.endsWith(".one"))
    .map((key) => key.slice(0, -".one".length));
}

function legacyPlural(catalog: Record<string, string>, base: string, count: number): string {
  const message = catalog[count === 1 ? `${base}.one` : `${base}.other`] ?? "";
  return message.replaceAll("{count}", String(count));
}

const UK = "uk-UA" as Locale;
const ukCatalog = {
  "files.one": "{count} файл",
  "files.few": "{count} файли",
  "files.many": "{count} файлів",
  "files.other": "{count} файлу",
  "partial.one": "{count} крок",
  "partial.other": "{count} кроку",
};
const enCatalog = {
  ...enUS,
  "files.one": "{count} file",
  "files.other": "{count} files",
  "enOnly.one": "{count} item",
  "enOnly.other": "{count} items",
  "only.en": "English only",
};

describe("createIntl formatPlural", () => {
  for (const [locale, catalog] of [
    ["en-US", enUS],
    ["zh-CN", zhCN],
  ] as const) {
    it(`matches the legacy one/other selection for ${locale}`, () => {
      const intl = createIntl(locale, { "en-US": enUS, [locale]: catalog });
      for (const base of pluralFamilies(catalog)) {
        for (const count of COUNTS) {
          if (locale === "zh-CN" && count === 1 && ZH_KNOWN_ONE_CHANGES.has(base)) continue;
          assert.equal(
            intl.formatPlural({ id: base }, count),
            legacyPlural(catalog, base, count),
            `${locale} ${base} @ ${count}`,
          );
        }
      }
    });
  }

  it("keeps caller-supplied count formatting", () => {
    const intl = createIntl("en-US", { "en-US": enCatalog });
    assert.equal(intl.formatPlural({ id: "files" }, 1200, { count: "1,200" }), "1,200 files");
  });

  it("selects Ukrainian one/few/many/other", () => {
    const intl = createIntl(UK, { "en-US": enCatalog, [UK]: ukCatalog });
    assert.equal(intl.formatPlural({ id: "files" }, 1), "1 файл");
    assert.equal(intl.formatPlural({ id: "files" }, 2), "2 файли");
    assert.equal(intl.formatPlural({ id: "files" }, 5), "5 файлів");
    assert.equal(intl.formatPlural({ id: "files" }, 21), "21 файл");
    assert.equal(intl.formatPlural({ id: "files" }, 1.5), "1.5 файлу");
  });

  it("falls back to .other in the same catalog, then to English with the English category", () => {
    const intl = createIntl(UK, { "en-US": enCatalog, [UK]: ukCatalog });
    assert.equal(intl.formatPlural({ id: "partial" }, 5), "5 кроку");
    assert.equal(intl.formatPlural({ id: "enOnly" }, 1), "1 item");
    assert.equal(intl.formatPlural({ id: "enOnly" }, 21), "21 items");
    assert.equal(intl.formatPlural({ id: "missing" }, 3), "missing.other");
  });
});

// Count strings that were a single "{count} …s" message now resolve through formatPlural; these are the real catalogs.
describe("count strings resolve through plural families in the shipped catalogs", () => {
  const cases: Array<{
    id: string;
    en: [string, string];
    zh: [string, string];
    uk: [string, string, string];
  }> = [
    {
      id: "archives.count",
      en: ["1 session", "2 sessions"],
      zh: ["1 个会话", "2 个会话"],
      uk: ["1 сесія", "2 сесії", "5 сесій"],
    },
    {
      id: "git.branchSwitcher.commitDialog.changesValue",
      en: ["1 file", "2 files"],
      zh: ["1 个文件", "2 个文件"],
      uk: ["1 файл", "2 файли", "5 файлів"],
    },
    {
      id: "chat.queue.sendConfirm.description",
      en: [
        "You're about to send a message. Clear the 1 previously queued message?",
        "You're about to send a message. Clear the 2 previously queued messages?",
      ],
      zh: [
        "你即将发送一条消息。要清除之前已排队的 1 条消息吗？",
        "你即将发送一条消息。要清除之前已排队的 2 条消息吗？",
      ],
      uk: [
        "Ви збираєтеся надіслати повідомлення. Очистити 1 раніше додане повідомлення з черги?",
        "Ви збираєтеся надіслати повідомлення. Очистити 2 раніше додані повідомлення з черги?",
        "Ви збираєтеся надіслати повідомлення. Очистити 5 раніше доданих повідомлень з черги?",
      ],
    },
  ];

  for (const { id, en, zh, uk } of cases) {
    it(`${id}: en uses one/other`, () => {
      const intl = createIntl("en-US", { "en-US": enUS });
      assert.equal(intl.formatPlural({ id }, 1), en[0]);
      assert.equal(intl.formatPlural({ id }, 2), en[1]);
    });

    it(`${id}: zh uses the single other form`, () => {
      const intl = createIntl("zh-CN", { "en-US": enUS, "zh-CN": zhCN });
      assert.equal(intl.formatPlural({ id }, 1), zh[0]);
      assert.equal(intl.formatPlural({ id }, 2), zh[1]);
    });

    it(`${id}: uk uses one/few/many`, () => {
      const intl = createIntl(UK, { "en-US": enUS, [UK]: ukUA });
      assert.equal(intl.formatPlural({ id }, 1), uk[0]);
      assert.equal(intl.formatPlural({ id }, 2), uk[1]);
      assert.equal(intl.formatPlural({ id }, 5), uk[2]);
    });
  }
});

describe("createIntl formatMessage fallback", () => {
  it("falls back to English when the locale catalog lacks a key", () => {
    const intl = createIntl(UK, { "en-US": enCatalog, [UK]: ukCatalog });
    assert.equal(intl.formatMessage({ id: "only.en" }), "English only");
  });

  it("falls back to English for zh keys missing from the zh catalog", () => {
    const missingInZh = Object.keys(enUS).filter((key) => zhCN[key] === undefined);
    assert.ok(missingInZh.length > 0);
    const intl = createIntl("zh-CN", { "en-US": enUS, "zh-CN": zhCN });
    for (const key of missingInZh) {
      assert.equal(intl.formatMessage({ id: key }), enUS[key]);
    }
  });

  it("returns the id when no catalog has the key", () => {
    const intl = createIntl("zh-CN", { "en-US": enUS, "zh-CN": zhCN });
    assert.equal(intl.formatMessage({ id: "does.not.exist" }), "does.not.exist");
  });
});
