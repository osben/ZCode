import assert from "node:assert/strict";
import test from "node:test";
import type { Locale, ZCodeTaskChangeSummary } from "@zcode/shared";
import {
  formatBotMessage,
  normalizeBotMessageLocale,
  type BotMessageId,
} from "../src/bots/messages.js";
import { formatBotAssistantReplyBlocks } from "../src/bots/replyFormatter.js";

const ALL_IDS: BotMessageId[] = ["helpTitle", "taskFailed", "remoteDisconnected", "replyChanged"];

function changeSummary(fileCount: number): ZCodeTaskChangeSummary {
  return {
    fileCount,
    added: 3,
    removed: 1,
    files: [{ path: "a.ts", added: 3, removed: 1, writeCount: 1, lastTurnIndex: 0 }],
  };
}

function summaryHeader(locale: Locale | undefined, fileCount: number): string {
  const [text] = formatBotAssistantReplyBlocks(
    [{ type: "change-summary", changeSummary: changeSummary(fileCount) }],
    { locale },
  );
  return text!.split("\n")[0]!;
}

test("bot messages keep zh default and map each UI locale to itself", () => {
  assert.equal(normalizeBotMessageLocale(undefined), "zh-CN");
  assert.equal(normalizeBotMessageLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeBotMessageLocale("en-US"), "en-US");
  assert.equal(normalizeBotMessageLocale("uk-UA"), "uk-UA");
});

test("uk bot messages are Ukrainian, keep placeholders and English command names", () => {
  assert.equal(formatBotMessage("uk-UA", "helpTitle"), "Команди бота ZCode:");
  assert.equal(
    formatBotMessage("uk-UA", "taskFailed", { message: "boom" }),
    "Не вдалося виконати завдання: boom",
  );
  // D10：命令名保持英文，不添加乌克兰语别名。
  assert.match(formatBotMessage("uk-UA", "helpWorkspace"), /^\*\*\/project\*\*/);
  for (const id of ALL_IDS) {
    const uk = formatBotMessage("uk-UA", id, { workspacePath: "/w", message: "m", mode: "x" });
    assert.doesNotMatch(uk, /[\u4e00-\u9fff]/u, `${id} must not contain Chinese`);
    assert.doesNotMatch(uk, /\{\w+\}/u, `${id} must substitute placeholders`);
  }
});

test("zh and en bot messages are unchanged", () => {
  assert.equal(formatBotMessage("en-US", "received"), "Received.");
  assert.equal(formatBotMessage("zh-CN", "received"), formatBotMessage(undefined, "received"));
});

test("change summary header pluralizes files per locale", () => {
  assert.match(summaryHeader("en-US", 2), /^Change summary: 2 files, /u);
  assert.match(summaryHeader("zh-CN", 2), /^变更摘要：2 个文件，/u);
  assert.match(summaryHeader("uk-UA", 1), /^Зведення змін: 1 файл, /u);
  assert.match(summaryHeader("uk-UA", 2), /^Зведення змін: 2 файли, /u);
  assert.match(summaryHeader("uk-UA", 5), /^Зведення змін: 5 файлів, /u);
  assert.match(summaryHeader("uk-UA", 21), /^Зведення змін: 21 файл, /u);
});
