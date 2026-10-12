// Formal E2E for PLG01 (wire half) + PLG12/PLG15 (store trial) + S01 (plugins group half):
// 1) The @ panel shows plugins-group candidates; after selecting one, the composer inserts the canonical `plugin://` markdown;
// 2) The plugin store detail page's Try now pre-fills only the canonical reference; the example prompt continues to pre-fill reference + prompt;
//    neither entry auto-sends;
// 3) After sending a message containing a canonical plugin reference, the provider request includes an identifiers-only
//    `plugin_reference` reminder (the deterministic replay fixture only lets the main response through with bodyIncludes
//    "<plugin_reference>", and drives one Read test tool call), and the final reply marker appears in the timeline;
//    the reminder never appears in the user-visible timeline, and the request carries no forbidden injected fields such as paths/env.
// The reference target is the officially enabled pure-content plugin skill-creator (stable id, no install step needed).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import { waitForUpstreamNetworkCapture } from "../helpers/upstream-capture.js";
import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared";
import {
  clickV4SlashOption,
  getV4ComposerText,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";
import {
  clickPluginControl,
  openPluginCard,
  openPluginSettings,
} from "../helpers/plugin-management-lifecycle.js";

const PLUGIN_STABLE_ID = "skill-creator@zcode-plugins-official";
const STORE_TRY_PLUGIN_STABLE_ID = "zcode-guide@zcode-plugins-official";
const STORE_TRY_PLUGIN_ICON =
  "https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-guide/icon.png";
const PROMPT_MARKER = "E2E_PLUGIN_REFERENCE";
const REPLY_MARKER = "PLUGIN_REFERENCE_REPLY_OK";
const NOTE_RELATIVE_PATH = "plugin-reference-e2e/note.md";
const NOTE_BODY = "PLUGIN_REFERENCE_NOTE_BODY";
const SCREENSHOT_DIR = join(process.cwd(), ".e2e-artifacts", "plugin-reference");

// Screenshots serve only as manual-review artifacts, not as pass criteria (conversation-session-ui-testid-contract).
async function captureEvidence(label: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await browser.saveScreenshot(join(SCREENSHOT_DIR, `${label}.png`));
}

async function readPluginMentionPresentation(pluginId: string): Promise<{
  found: boolean;
  iconSrc: string | null;
  label: string;
}> {
  return browser.execute(
    (inputTestId, mentionId) => {
      const input = document.querySelector<HTMLElement>(
        `[data-testid="${inputTestId}"]`,
      );
      const mention = Array.from(
        input?.querySelectorAll<HTMLElement>("[data-mention-category='plugins']") ?? [],
      ).find((element) => element.getAttribute("data-mention-id") === mentionId);
      return {
        found: Boolean(mention),
        iconSrc: mention?.querySelector<HTMLImageElement>(
          "img[data-plugin-mention-icon='true']",
        )?.src ?? null,
        label: mention?.textContent ?? "",
      };
    },
    TID_V4_COMPOSER_INPUT,
    `plugin:${pluginId}`,
  );
}

// Goes through the product's own editor.focus() (the same path as Try now's requestFocus) so the
// native selection is restored by the real logic before real keys are sent.
async function focusV4Composer(): Promise<void> {
  await browser.execute((inputTestId) => {
    const input = document.querySelector<
      HTMLElement & { __zcodeLexicalInputE2E?: { focus: () => void } }
    >(`[data-testid="${inputTestId}"]`);
    input?.__zcodeLexicalInputE2E?.focus();
  }, TID_V4_COMPOSER_INPUT);
}

describe("PLG plugin 引用：@ 面板 plugins 分组与 plugin_reference reminder", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("@ 面板展示 plugins 分组候选，选中后插入 canonical plugin:// markdown", async () => {
    await prepareV4ConversationE2E();
    await startNewV4Draft();

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@zcode-guide", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    const pluginOptionId = await waitForV4MentionOptionPrefix(
      `plugin:${STORE_TRY_PLUGIN_STABLE_ID}`,
      30000,
    );
    expect(pluginOptionId).toBe(`plugin:${STORE_TRY_PLUGIN_STABLE_ID}`);
    const pickerIcon = await browser.execute(
      (optionTestId) =>
        document
          .querySelector<HTMLElement>(`[data-testid="${optionTestId}"]`)
          ?.querySelector<HTMLImageElement>("img")?.src ?? null,
      testId(TID_PROMPT_SUGGESTION_OPTION, pluginOptionId),
    );
    expect(pickerIcon).toBe(STORE_TRY_PLUGIN_ICON);
    await captureEvidence("01-picker-plugins-group");

    expect(await clickV4SlashOption(pluginOptionId)).toBe(true);
    await browser.waitUntil(
      async () => ((await getV4ComposerText()) ?? "").includes("plugin://"),
      {
        timeout: 15000,
        timeoutMsg: "选中 plugin mention 后 composer 没有插入 canonical plugin:// markdown",
      },
    );
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 plugin mention 后面板没有关闭",
    });
    expect(await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID)).toEqual({
      found: true,
      iconSrc: STORE_TRY_PLUGIN_ICON,
      label: "zcode-guide",
    });
    await captureEvidence("02-composer-plugin-chip");

    // Clear the draft so later cases are unaffected.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
  });

  it("Plugin 商店顶部 Try now 只预填 canonical 引用且不自动发送", async () => {
    await openPluginSettings();
    await openPluginCard(STORE_TRY_PLUGIN_STABLE_ID);
    await captureEvidence("03-plugin-store-try-now-detail");
    await clickPluginControl("plugin-store-try-now", {
      pluginId: STORE_TRY_PLUGIN_STABLE_ID,
    });

    await waitForV4Pane(
      (state) => state.sessionId === "draft" && !state.canStop,
      "Plugin 商店 Try now 没有通过标准新建任务进入空闲草稿",
      30000,
    );
    await browser.waitUntil(
      async () => ((await getV4ComposerText()) ?? "").includes(
        `plugin://${STORE_TRY_PLUGIN_STABLE_ID}`,
      ),
      {
        timeout: 30000,
        timeoutMsg: "Plugin 商店 Try now 没有预填 canonical Plugin 引用",
      },
    );
    const tryNowText = (await getV4ComposerText()) ?? "";
    for (const prompt of [
      "How do I configure MCP servers in ZCode?",
      "Diagnose my current ZCode setup",
      "ZCode 里怎么配置 MCP 服务器？",
      "帮我诊断当前的 ZCode 配置",
    ]) {
      expect(tryNowText).not.toContain(prompt);
    }
    const tryNowMention = await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID);
    expect(tryNowMention.found).toBe(true);
    expect(tryNowMention.iconSrc).toBe(STORE_TRY_PLUGIN_ICON);
    expect(["ZCode Guide", "ZCode 使用指南"]).toContain(tryNowMention.label);
    await captureEvidence("04-plugin-store-try-now-draft");

    // Regression guard: when Try now pre-fills only the reference with no trailing text, the cursor
    // lands inside the mention token, and pressing a real space makes Lexical replace the whole
    // node by token semantics, so the reference vanishes outright (v3.7.1~v3.7.6). Real keys are
    // required here; jsdom structural assertions cannot cover the native selection restoration.
    await focusV4Composer();
    await browser.keys(" ");
    const afterSpaceMention = await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID);
    expect(afterSpaceMention.found).toBe(true);
    expect((await getV4ComposerText()) ?? "").toContain(
      `plugin://${STORE_TRY_PLUGIN_STABLE_ID}`,
    );
    await captureEvidence("04b-plugin-store-try-now-after-space");

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "Plugin 商店 Try now 后的 v4 composer 不可编辑",
    });
  });

  it("Plugin 商店示例提示词预填 canonical 引用与提示词但不自动发送", async () => {
    await openPluginSettings();
    await openPluginCard(STORE_TRY_PLUGIN_STABLE_ID);
    await clickPluginControl("plugin-store-example-prompt", {
      pluginId: STORE_TRY_PLUGIN_STABLE_ID,
    });

    await waitForV4Pane(
      (state) => state.sessionId === "draft" && !state.canStop,
      "Plugin 商店试用没有通过标准新建任务进入空闲草稿",
      30000,
    );
    await browser.waitUntil(
      async () => {
        const text = (await getV4ComposerText()) ?? "";
        return (
          text.includes(`plugin://${STORE_TRY_PLUGIN_STABLE_ID}`) &&
          [
            "How do I configure MCP servers in ZCode?",
            "Diagnose my current ZCode setup",
            "ZCode 里怎么配置 MCP 服务器？",
            "帮我诊断当前的 ZCode 配置",
          ].some((prompt) => text.includes(prompt))
        );
      },
      {
        timeout: 30000,
        timeoutMsg: "Plugin 商店试用没有预填 canonical Plugin 引用与示例提示词",
      },
    );
    const storeMention = await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID);
    expect(storeMention.found).toBe(true);
    expect(storeMention.iconSrc).toBe(STORE_TRY_PLUGIN_ICON);
    expect(["ZCode Guide", "ZCode 使用指南"]).toContain(storeMention.label);
    await captureEvidence("03-plugin-store-try-draft");

    // The trial only pre-fills and never auto-sends; keep it a draft and clear it manually so the wire cases are unaffected.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "Plugin 商店试用后的 v4 composer 不可编辑",
    });
  });

  it("发送 canonical plugin 引用后 provider 收到 identifiers-only reminder 并驱动测试工具", async function () {
    this.timeout(240000);
    // The target file of the Read test tool (workspace-relative path, honoring the e2e runtime path contract).
    await mkdir(join(DEFAULT_WORKSPACE, "plugin-reference-e2e"), { recursive: true });
    await writeFile(join(DEFAULT_WORKSPACE, "plugin-reference-e2e", "note.md"), NOTE_BODY, "utf8");

    await sendV4Prompt(
      `${PROMPT_MARKER} read ${NOTE_RELATIVE_PATH} with [@skill-creator](plugin://${PLUGIN_STABLE_ID})`,
    );
    await waitForV4TimelineContaining(REPLY_MARKER, 60000);
    await waitForV4Pane(
      (state) => !state.canStop && state.sessionId !== "draft" && state.sessionId !== null,
      "plugin 引用回合没有回到空闲态",
      60000,
    );
    await captureEvidence("04-timeline-plugin-reference-reply");

    // Wire assertion: the main request contains exactly one identifiers-only plugin_reference reminder.
    const capture = await waitForUpstreamNetworkCapture("<plugin_reference>");
    const serialized = JSON.stringify(capture.requestJson);
    expect(serialized).toContain(PLUGIN_STABLE_ID);
    expect((serialized.match(/<plugin_reference>/g) ?? []).length).toBe(1);
    // identifiers-only: forbidden injected fields (paths, plugin env vars, the rootPath field name) must not enter the provider input.
    expect(serialized).not.toContain("ZCODE_PLUGIN_ROOT");
    expect(serialized).not.toContain('"rootPath"');

    // The reminder is model-only: the user-visible timeline must not render the plugin_reference tag.
    const timelineHasReminder = await browser.execute(() =>
      (document.body.textContent ?? "").includes("<plugin_reference>"),
    );
    expect(timelineHasReminder).toBe(false);
  });
});
