// M5 gate: the composer toolbar (model selector / thought level / mode / slash candidate panel).
// Evidence tier L3:
// 1) slash panel — shows the CLI builtin and App Composer-only catalog (compact/goal/init/plan; no resume-goal), fuzzy filtering, and inserting a command pill on selection;
// 2) model selector — after switching to another registered model + thought level, the Composer Draft updates immediately;
// 3) mode selection — ChatModeSwitchControl immediately updates the same Composer Draft;
// 4) context usage — the usage.contextWindow projection after the first ModelComplete (data-usage-used>0).
// 5) task -> draft — even with a model catalog present, the slash catalog rehydrates independently and custom commands keep appearing.
// 6) draft -> known task — the same workspace's slash catalog is not cleared by task navigation.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import { UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL } from "../helpers/upstream-provider.js";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared";
import {
  clickV4SlashOption,
  getV4ComposerText,
  getV4ConfigProjection,
  getV4ModelConfig,
  getV4PaneSnapshot,
  getV4SlashOptionIds,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  startNewV4Draft,
  switchV4Mode,
  switchV4Model,
  waitForV4Pane,
  waitForV4SlashOption,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CUSTOM_SLASH_COMMAND_NAME = "e2e-draft-catalog";
const CUSTOM_SLASH_OPTION_ID = `slash:${CUSTOM_SLASH_COMMAND_NAME}`;
const CUSTOM_SLASH_COMMAND_DIR = join(getE2EAppDataPaths().homeDir, ".zcode", "commands");
const CUSTOM_SLASH_COMMAND_PATH = join(CUSTOM_SLASH_COMMAND_DIR, `${CUSTOM_SLASH_COMMAND_NAME}.md`);
const COMPOSER_PICKER_TRIGGER_IDS = {
  mode: TID_CHAT_MODE_SELECT_TRIGGER,
  model: TID_CHAT_MODEL_SELECT_TRIGGER,
  thought: TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
} as const;

type ComposerPicker = keyof typeof COMPOSER_PICKER_TRIGGER_IDS;

async function openComposerPicker(picker: ComposerPicker) {
  const trigger = $(`[data-testid="${COMPOSER_PICKER_TRIGGER_IDS[picker]}"]`);
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
}

async function waitForOnlyComposerPickerOpen(picker: ComposerPicker, transition: string) {
  let latest: unknown = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute((triggerIds) => {
        const expanded = Object.fromEntries(
          Object.entries(triggerIds).map(([key, testId]) => [
            key,
            document
              .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
              ?.getAttribute("aria-expanded") ?? null,
          ]),
        );
        return {
          expanded,
          listboxes: document.querySelectorAll('[role="listbox"]').length,
          menus: document.querySelectorAll('[role="menu"]').length,
        };
      }, COMPOSER_PICKER_TRIGGER_IDS);
      const state = latest as {
        expanded: Record<ComposerPicker, string | null>;
        listboxes: number;
        menus: number;
      };
      const expectedListboxes = picker === "model" ? 0 : 1;
      const expectedMenus = picker === "model" ? 1 : 0;
      return (
        state.expanded[picker] === "true" &&
        Object.entries(state.expanded).every(
          ([key, value]) => key === picker || value !== "true",
        ) &&
        state.listboxes === expectedListboxes &&
        state.menus === expectedMenus
      );
    },
    {
      timeout: 5000,
      timeoutMsg: `${transition} 后没有只保留目标 picker；latest=${JSON.stringify(latest)}`,
    },
  );
}

async function waitForNoComposerPickerOpen(transition: string) {
  let latest: unknown = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (triggerIds) => ({
          expanded: Object.fromEntries(
            Object.entries(triggerIds).map(([key, testId]) => [
              key,
              document
                .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
                ?.getAttribute("aria-expanded") ?? null,
            ]),
          ),
          listboxes: document.querySelectorAll('[role="listbox"]').length,
          menus: document.querySelectorAll('[role="menu"]').length,
        }),
        COMPOSER_PICKER_TRIGGER_IDS,
      );
      const state = latest as {
        expanded: Record<ComposerPicker, string | null>;
        listboxes: number;
        menus: number;
      };
      return (
        Object.values(state.expanded).every((value) => value !== "true") &&
        state.listboxes === 0 &&
        state.menus === 0
      );
    },
    {
      timeout: 5000,
      timeoutMsg: `${transition} 后 composer picker 没有全部关闭；latest=${JSON.stringify(latest)}`,
    },
  );
}

async function closeComposerPicker() {
  await browser.keys("Escape");
  await waitForNoComposerPickerOpen("Escape");
}

describe("v4 M5 门禁：composer 工具条与 slash 候选面板", () => {
  let completedTaskId: string | null = null;
  let customSlashHydratedInDraft = false;

  async function ensureCompletedTask() {
    if (completedTaskId) {
      return completedTaskId;
    }
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED 建立会话");
    await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态",
      45000,
    );
    completedTaskId = (await getV4PaneSnapshot()).sessionId;
    if (!completedTaskId || completedTaskId === "draft") {
      throw new Error("composer toolbar 首轮没有留下可重新打开的 completed task");
    }
    return completedTaskId;
  }

  async function ensureCustomSlashHydratedInDraft() {
    if (customSlashHydratedInDraft) {
      return;
    }
    await startNewV4Draft();
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      timeout: 15000,
      timeoutMsg: "task → draft 后 v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption(CUSTOM_SLASH_OPTION_ID);
    expect(await getV4SlashOptionIds()).toContain(CUSTOM_SLASH_OPTION_ID);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "task → draft slash 回归断言后没有清空 composer",
    });
    customSlashHydratedInDraft = true;
  }

  before(async () => {
    await mkdir(CUSTOM_SLASH_COMMAND_DIR, { recursive: true });
    await writeFile(
      CUSTOM_SLASH_COMMAND_PATH,
      [
        "---",
        "description: E2E task-to-draft slash catalog rehydration",
        "argument-hint: [scope]",
        "---",
        "",
        "Draft slash catalog fixture $ARGUMENTS.",
      ].join("\n"),
      "utf-8",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(CUSTOM_SLASH_COMMAND_PATH, { force: true });
    await clearAppData();
  });

  it("slash 面板：/ 触发目录候选，过滤后选中插入命令", async () => {
    await prepareV4ConversationE2E();

    // `/` trigger: all builtin commands of the CLI protocol catalog appear; UI-private aliases do not.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:compact");
    await waitForV4SlashOption("slash:init");
    await waitForV4SlashOption("slash:plan");
    const optionIds = await getV4SlashOptionIds();
    expect(optionIds).toContain("slash:compact");
    expect(optionIds).toContain("slash:goal");
    expect(optionIds).toContain("slash:init");
    expect(optionIds).toContain("slash:plan");
    expect(optionIds).not.toContain("slash:resume-goal");

    // The App-only `/plan` is still inserted as an ordinary slash catalog mention, letting the user keep filling in task parameters.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/plan", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:plan");
    expect(await clickV4SlashOption("slash:plan")).toBe(true);
    await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").startsWith("/plan"), {
      timeout: 15000,
      timeoutMsg: "选中 /plan 后命令没有插入 composer",
    });
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "选中 /plan 后没有清空 composer",
    });

    // Fuzzy filtering: /goa -> goal still among candidates
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/goa", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:goal");

    // On selection: the `/goal ` command text is inserted (the mention pill's markdown) and the panel closes
    expect(await clickV4SlashOption("slash:goal")).toBe(true);
    await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").startsWith("/goal"), {
      timeout: 15000,
      timeoutMsg: "选中 slash 候选后命令没有插入 composer",
    });
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 slash 候选后面板没有关闭",
    });

    // Clear the draft so later cases are unaffected
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
  });

  it("模型选择器/思考深度/模式切换 → config 投影更新；usage 投影非零", async () => {
    await ensureCompletedTask();

    // Segmented waits carrying the latest projection values (the timeout message includes the config's current value, making it easy to locate which segment is stuck).
    const waitForModelConfig = async (
      predicate: (cfg: {
        provider: string | null;
        model: string | null;
        thought: string | null;
      }) => boolean,
      label: string,
    ) => {
      let latest: unknown = null;
      try {
        await browser.waitUntil(
          async () => {
            const cfg = await getV4ModelConfig();
            latest = cfg;
            return predicate(cfg);
          },
          { timeout: 30000, timeoutMsg: label },
        );
      } catch (error) {
        // Failure diagnostics: the v4 command ack ring buffer (production renderer logging is off; this is the only probe surface).
        const acks = await browser
          .execute(() =>
            JSON.stringify(
              (window as Window & { __zcodeV4CommandAcksE2E?: unknown[] })
                .__zcodeV4CommandAcksE2E ?? [],
            ),
          )
          .catch(() => "acks unavailable");
        throw new Error(`${label}; latest=${JSON.stringify(latest)}; acks=${acks}`, {
          cause: error,
        });
      }
    };

    // Model selector: switch to the second registered model + thought=max
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    await waitForModelConfig(
      (cfg) => cfg.model === UPSTREAM_SECONDARY_MODEL,
      "模型选择器切换后 config.model 投影没有更新",
    );
    await waitForModelConfig(
      (cfg) => cfg.thought === "max",
      "思考深度切换后 config.thought 投影没有更新",
    );
    const cfg = await getV4ModelConfig();
    expect(cfg.provider).toBe(UPSTREAM_PROVIDER_ID);

    // Mode selection: build -> plan (observing the Composer's current state only)
    await switchV4Mode("plan");
    let latestMode: string | null = null;
    try {
      await browser.waitUntil(
        async () => {
          latestMode = (await getV4ModelConfig()).mode;
          return latestMode === "plan";
        },
        { timeout: 30000, timeoutMsg: "模式切换后 config.mode 投影没有更新为 plan" },
      );
    } catch (error) {
      throw new Error(`模式切换后 config.mode 投影没有更新为 plan; latest=${latestMode}`, {
        cause: error,
      });
    }

    // context usage: the usage.contextWindow projection is non-zero after the first ModelComplete
    const projection = await getV4ConfigProjection();
    expect(projection.usageUsed).toBeGreaterThan(0);
  });

  it("模式/模型/思考深度 picker 互斥，后打开者保持唯一可见", async () => {
    await ensureCompletedTask();

    await openComposerPicker("mode");
    await waitForOnlyComposerPickerOpen("mode", "打开模式 picker");
    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "Select→Dropdown");
    await closeComposerPicker();

    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "打开模型 picker");
    await openComposerPicker("thought");
    await waitForOnlyComposerPickerOpen("thought", "Dropdown→Select");
    await closeComposerPicker();

    await openComposerPicker("mode");
    await waitForOnlyComposerPickerOpen("mode", "重新打开模式 picker");
    await openComposerPicker("thought");
    await waitForOnlyComposerPickerOpen("thought", "Select→Select");
    await closeComposerPicker();
  });

  it("completed task 的 picker 不跨 scope 自动弹到新 draft", async () => {
    await ensureCompletedTask();
    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "completed task 打开模型 picker");

    await startNewV4Draft();
    await waitForNoComposerPickerOpen("completed task→draft");
  });

  it("completed task → draft 后独立重新水合自定义 slash command", async () => {
    // Bug cause: task -> draft kept the model catalog but cleared slashCommands; the old
    // hydration gate only checked the model catalog, so real user-scope custom commands never
    // re-entered the composer candidates.
    await ensureCompletedTask();
    await ensureCustomSlashHydratedInDraft();
  });

  it("draft → 已知 completed task 后保留自定义 slash command", async () => {
    // Bug cause: Mocha grep skips the prerequisite its that build the task and hydrate the draft;
    // depending on describe-scoped variables made this case impossible to replay independently.
    // Here S03's own prerequisite state is idempotently completed, while a full-group run still
    // reuses the existing state.
    const taskId = await ensureCompletedTask();
    await ensureCustomSlashHydratedInDraft();
    // Bug cause: the old task navigation cleared the workspace-level slashCommands, but the
    // session projection only restores session state and never back-fills the workspace catalog
    // the composer consumes.
    await selectV4TaskById(taskId);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
      timeoutMsg: "draft → 已知 task 后 v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption(CUSTOM_SLASH_OPTION_ID);
    expect(await getV4SlashOptionIds()).toContain(CUSTOM_SLASH_OPTION_ID);

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "已知 task slash 回归断言后没有清空 composer",
    });
  });
});
