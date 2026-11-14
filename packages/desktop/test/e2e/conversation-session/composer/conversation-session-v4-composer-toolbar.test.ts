// M5 gate: the composer toolbar (model selector / thought level / mode / voice entry / slash candidate panel).
// Evidence tier L3:
// 1) slash panel — shows the CLI builtin and App Composer-only catalog (compact/goal/init/plan; no resume-goal), fuzzy filtering, and inserting a command pill on selection;
// 2) model selector — after switching to another registered model + thought level, the Composer Draft updates immediately;
// 3) mode selection — ChatModeSwitchControl immediately updates the same Composer Draft;
// 4) context usage — the usage.contextWindow projection after the first ModelComplete (data-usage-used>0).
// 5) task -> draft — even with a model catalog present, the slash catalog rehydrates independently and custom commands keep appearing.
// 6) draft -> known task — the same workspace's slash catalog is not cleared by task navigation;
// 7) voice entry — enabled dictation stays in the primary toolbar and exposes a separate shortcut hint.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  readModelProvider,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
} from "#e2e/helpers/upstream-provider";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_COMPOSER_VOICE_ENTRY,
} from "@zcode/shared";
import {
  clickV4SlashOption,
  getV4ComposerText,
  setV4ComposerText,
  getV4ConfigProjection,
  getV4ModelConfig,
  getLatestV4CommandAck,
  getV4PaneSnapshot,
  getV4SlashOptionIds,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  startNewV4Draft,
  switchV4Model,
  waitForV4Pane,
  waitForV4SlashOption,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

import {
  waitForUpstreamNetworkCapture,
  assertUpstreamThoughtLevelCapture,
  assertUpstreamRequestCapture,
} from "#e2e/helpers/upstream-capture";

import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

import { seedPersonalProviderConfig } from "#e2e/helpers/model-provider-restart-config";
import { waitForProviderConfigPolling } from "#e2e/helpers/provider-config-polling";

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

const ACK_PROVIDER = "e2e-ack-glm";
async function seedAckProvider() {
  const upstream = await readModelProvider(UPSTREAM_PROVIDER_ID);
  if (!upstream) throw new Error("缺少回放 Provider");
  await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
    id: ACK_PROVIDER,
    label: "ACK GLM",
    apiFormat: "anthropic-messages",
    apiKey: upstream.apiKey,
    baseURL: upstream.endpoints.anthropic ?? upstream.endpoints.baseURL!,
    models: [
      {
        id: "GLM-5.3",
        reasoningLevel: {
          values: ["high", "max"],
          map: '{"thinking":{"type":"enabled"},"output_config":{"effort":reasoningLevel}}',
        },
      },
    ],
  });
  await waitForProviderConfigPolling();
}

async function expectPersistedThought(sessionId: string, thought: string) {
  const db = new DatabaseSync(join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    await browser.waitUntil(
      () => {
        const row = db
          .prepare(
            "SELECT data FROM session_entry WHERE session_id=? AND type='runtime/model_selection' ORDER BY id DESC LIMIT 1",
          )
          .get(sessionId) as { data: string } | undefined;
        return Boolean(
          row && JSON.parse(row.data).modelSelection?.options?.reasoningLevel === thought,
        );
      },
      { timeout: 10000, timeoutMsg: "仅切换档位未写入 Session Selection" },
    );
  } finally {
    db.close();
  }
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
    // 仅改档位且不发送：Bot 读取的是 Session，不是 Composer 的展示值。
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "high");
    await expectPersistedThought(completedTaskId!, "high");
    await browser.keys(["Control", "t"]);
    await browser.waitUntil(async () => (await getV4ModelConfig()).thought !== "high", {
      timeout: 10000,
    });
    await expectPersistedThought(completedTaskId!, (await getV4ModelConfig()).thought!);

    // Keep the merged menu open after choosing a model so settings can be tuned further; choosing the current model again also keeps it open.
    for (const selected of [false, true]) {
      await openComposerPicker("model");
      const option = $(
        `[data-testid^="chat-model-select-item-"]${selected ? '[data-checked="true"]' : ':not([data-checked="true"])'}:not([data-model-option-locked])`,
      );
      await option.waitForClickable({ timeout: 15000 });
      const value = (await option.getAttribute("data-testid"))!.slice(
        "chat-model-select-item-".length,
      );
      await option.click();
      await waitForOnlyComposerPickerOpen(
        "model",
        selected ? "reselect current model" : "select another model",
      );
      await browser.waitUntil(
        async () =>
          (await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).getAttribute(
            "data-model-current-value",
          )) === value,
        { timeout: 15000 },
      );
      await closeComposerPicker();
    }

    // Click only the Provider without sending: the session config must be confirmed so the Feishu side reads the new selection immediately.
    await browser.execute(() => {
      (window as Window & { __zcodeV4CommandAcksE2E?: unknown[] }).__zcodeV4CommandAcksE2E = [];
    });
    await openComposerPicker("model");
    await $('[data-testid="composer-provider-trigger"]').click();
    await $(
      `[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`,
    ).click();
    await waitForModelConfig(
      (value) =>
        value.provider === UPSTREAM_ALTERNATE_PROVIDER_ID &&
        value.model === UPSTREAM_ALTERNATE_MODEL,
      "Target model was not auto-selected after clicking the Provider",
    );
    await waitForOnlyComposerPickerOpen(
      "model",
      "Existing session keeps the popover after switching the Provider",
    );
    await browser.waitUntil(
      async () => {
        const slider = $('[data-testid="composer-thought-slider"]');
        const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
        return levels.includes((await getV4ModelConfig()).thought ?? "");
      },
      {
        timeout: 15000,
        timeoutMsg: "Think did not sync to a valid level after switching the Provider",
      },
    );
    await browser.waitUntil(
      async () => (await getLatestV4CommandAck("switchModelConfig"))?.status === "accepted",
      {
        timeout: 15000,
        timeoutMsg: "Provider switch did not get a successful session-config receipt",
      },
    );
    await waitForOnlyComposerPickerOpen(
      "model",
      "Original popover stays open after config confirmation",
    );
    await closeComposerPicker();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");

    // Plan is now an independent toggle; with it on, build mode is kept, so the old mode=plan must not be asserted.
    const catalogProbe = await browser.execute(() => {
      const target = window as Window & {
        __composerCatalogProbe?: { empty: number; disabled: number; samples: number; stop(): void };
      };
      const probe = target.__composerCatalogProbe!;
      probe.stop();
      delete target.__composerCatalogProbe;
      return { empty: probe.empty, disabled: probe.disabled, samples: probe.samples };
    });
    expect(catalogProbe.samples).toBeGreaterThan(0);
    expect(catalogProbe.empty).toBe(0);
    // The panel stays mounted, so the disabled frames during the ACK can be observed; the catalog must still not be cleared.
    expect(catalogProbe.disabled).toBeGreaterThan(0);
    const modeTrigger = await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`);
    await browser.execute((id) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      const probe = {
        animated: false,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        stop: () => {},
      };
      const observer = new MutationObserver(() => {
        for (const node of trigger.querySelectorAll<HTMLElement>("[style]")) {
          const style = getComputedStyle(node);
          if (style.transform !== "none" && Number(style.opacity) > 0 && Number(style.opacity) < 1)
            probe.animated = true;
        }
      });
      observer.observe(trigger, { subtree: true, attributes: true, attributeFilter: ["style"] });
      probe.stop = () => observer.disconnect();
      (window as Window & { __modeRollProbe?: typeof probe }).__modeRollProbe = probe;
    }, TID_CHAT_MODE_SELECT_TRIGGER);
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

  it("enabled voice dictation stays in the primary toolbar with a separate shortcut hint", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });

    const voiceButton = $(`[data-testid="${TID_V4_COMPOSER_VOICE_ENTRY}"]`);
    await voiceButton.waitForDisplayed({ timeout: 15000 });
    const control = await browser.execute((voiceTestId) => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${voiceTestId}"]`);
      return {
        inPrimaryToolbar: Boolean(button?.closest("[data-composer-trailing-actions]")),
        inLeadingActions: Boolean(button?.closest("[data-composer-leading-actions]")),
        accessibleName: button?.getAttribute("aria-label") ?? null,
        phase: button?.getAttribute("data-voice-phase") ?? null,
      };
    }, TID_V4_COMPOSER_VOICE_ENTRY);

    expect(control.inPrimaryToolbar).toBe(true);
    expect(control.inLeadingActions).toBe(false);
    expect(control.accessibleName).toBeTruthy();
    expect(control.phase).toBe("idle");
    const sendButton = $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`);
    expect(await voiceButton.getSize()).toEqual(await sendButton.getSize());

    await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).moveTo();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !Array.from(
              document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]'),
            ).some((element) => element.getClientRects().length > 0),
        ),
      { timeoutMsg: "previous composer tooltip did not close before hovering voice dictation" },
    );
    await voiceButton.moveTo();

    const readVoiceTooltip = () =>
      browser.execute((accessibleName) => {
        const visible = Array.from(
          document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]'),
        ).find((element) => {
          const style = window.getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0 &&
            element.getClientRects().length > 0 &&
            element.querySelector("span")?.textContent?.trim() === accessibleName
          );
        });
        return visible
          ? {
              label: visible.querySelector("span")?.textContent?.trim() ?? null,
              shortcut: visible.querySelector('kbd[data-slot="kbd"]')?.textContent?.trim() ?? null,
            }
          : null;
      }, control.accessibleName);
    await browser.waitUntil(
      async () => {
        const tooltip = await readVoiceTooltip();
        return Boolean(tooltip?.label && tooltip.shortcut);
      },
      {
        timeout: 5000,
        timeoutMsg: "voice dictation tooltip did not show separate action and shortcut hints",
      },
    );

    const tooltip = await readVoiceTooltip();
    expect(tooltip?.label).toBe(control.accessibleName);
    expect(tooltip?.shortcut).toBeTruthy();
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

  it("draft: slider dots grow on hover and remain white on the filled track", async () => {
    // Declare expectations through the named model's own replay, so the test does not reuse the product's name-matching implementation.
    const highspeed = process.env.E2E_COMPOSER_EXPECT_HIGHSPEED === "1";
    await ensureCompletedTask();
    // An unbound draft has no config ACK, so consecutive tuning keeps the popover open; the existing-session gate is verified by CPG02.
    await startNewV4Draft();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    if (highspeed) {
      // Replay requests keep using the recorded model; the named model is only checked for display and sends no request.
      const model = process.env.E2E_COMPOSER_ANIMATION_MODEL || "GLM-5.3-FlashX";
      await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
        id: "e2e-animation-model",
        label: "Animation Fixture",
        apiFormat: "anthropic-messages",
        apiKey: "e2e-fixture-key",
        baseURL: "http://127.0.0.1:1/v1",
        models: [{ id: model, reasoningLevel: { values: ["high", "max"], map: "{}" } }],
      });
      await waitForProviderConfigPolling();
      await switchV4Model("e2e-animation-model", model, "high");
    }
    await openComposerPicker("model");
    const slider = $('[data-testid="composer-thought-slider"]');
    expect(await $(".composer-thought-slider-fill").getAttribute("data-highspeed")).toBe(
      String(highspeed),
    );
    expect(await $('[data-testid="composer-thought-meter"]').getAttribute("data-highspeed")).toBe(
      String(highspeed),
    );
    const filledOpacity = await browser.execute(
      () =>
        getComputedStyle(
          document.querySelector('[data-composer-thought-stop][data-filled="true"]')!,
        ).opacity,
    );
    expect(filledOpacity).toBe("0.3");
    const sliderSize = await slider.getSize();
    await slider.moveTo({ xOffset: Math.round(16 - sliderSize.width / 2), yOffset: 0 });
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const dot = document.querySelector<HTMLElement>("[data-composer-thought-stop]")!;
          return Number.parseFloat(getComputedStyle(dot).scale) > 1.7;
        }),
      { timeout: 3000 },
    );
    const filledColor = await browser.execute(() => {
      const dot = document.querySelector<HTMLElement>(
        '[data-composer-thought-stop][data-filled="true"]',
      )!;
      return getComputedStyle(dot).backgroundColor;
    });
    expect(filledColor).toBe("rgb(255, 255, 255)");
    const drag = await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="composer-thought-slider"]',
      )!;
      const rect = input.getBoundingClientRect();
      return {
        x: Math.round(
          rect.left + 14 + ((rect.width - 28) * Number(input.value)) / Number(input.max),
        ),
        y: Math.round(rect.top + rect.height / 2),
        target: Math.round(rect.left + 14),
      };
    });
    await browser.performActions([
      {
        type: "pointer",
        id: "slider-drag",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: drag.x, y: drag.y },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 150, x: drag.target, y: drag.y },
        ],
      },
    ]);
    const dragMotion = await browser.execute(() => ({
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      thumb: getComputedStyle(document.querySelector(".composer-thought-slider-thumb")!)
        .transitionDuration,
      fill: getComputedStyle(document.querySelector(".composer-thought-slider-fill")!)
        .transitionDuration,
    }));
    await browser.releaseActions();
    expect(dragMotion.thumb).toBe(dragMotion.reduced ? "0s" : "0.12s");
    expect(dragMotion.fill).toBe(dragMotion.thumb);
    await slider.click();
    await browser.keys("End");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            getComputedStyle(document.querySelector(".composer-thought-slider-fill")!, "::before")
              .opacity === "1",
        ),
      { timeout: 3000 },
    );
    const gradientColors = await browser.execute(() => {
      const fill = document.querySelector<HTMLElement>(".composer-thought-slider-fill")!;
      const marker = document.createElement("span");
      marker.style.color = "var(--composer-thought-max-accent)";
      fill.append(marker);
      const accent = getComputedStyle(marker).color;
      marker.style.color = "var(--color-purple-500)";
      const purple = getComputedStyle(marker).color;
      marker.remove();
      return { gradient: getComputedStyle(fill, "::before").backgroundImage, accent, purple };
    });
    expect(gradientColors.gradient).toContain(gradientColors.accent);
    if (highspeed) {
      // Chromium omits 'in oklab' when serializing the default OKLab; check the real purple endpoints and the hue-free interpolation.
      expect(gradientColors.gradient).toContain(gradientColors.purple);
      expect(gradientColors.gradient).not.toContain("in oklch");
    } else expect(gradientColors.gradient).toContain("in oklch");
    const bubbles = await browser.execute(() => {
      const layer = document.querySelector<HTMLElement>(
        '[data-testid="composer-thought-bubbles"]',
      )!;
      return {
        count: layer.children.length,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        display: getComputedStyle(layer).display,
        animation: getComputedStyle(layer.firstElementChild!).animationName,
        duration: parseFloat(getComputedStyle(layer.firstElementChild!).animationDuration),
      };
    });
    expect(bubbles.count).toBe(highspeed ? 32 : 12);
    if (highspeed && !bubbles.reduced) {
      expect(bubbles.duration).toBeGreaterThanOrEqual(0.8);
      expect(bubbles.duration).toBeLessThanOrEqual(1.2);
    }
    expect(bubbles.animation).toBe(bubbles.reduced ? "none" : "composer-thought-bubble-flow");
    if (bubbles.reduced) expect(bubbles.display).toBe("none");
    await browser.keys("ArrowLeft");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            getComputedStyle(document.querySelector(".composer-thought-slider-fill")!, "::before")
              .opacity === "0",
        ),
      { timeout: 3000 },
    );
    expect(await $('[data-testid="composer-thought-bubbles"]').isExisting()).toBe(false);
    await closeComposerPicker();
    if (highspeed) await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "high");
  });

  it("the model management entry sits in the Provider submenu and opens model settings", async () => {
    await ensureCompletedTask();
    await openComposerPicker("model");
    expect(await $('[data-model-footer-action="manage-models"]').isExisting()).toBe(false);
    const provider = $('[data-testid="composer-provider-trigger"]');
    expect(await provider.$('img, svg[aria-hidden="true"]').isExisting()).toBe(true);
    await provider.click();
    const providerMenu = await $('[data-slot="dropdown-menu-sub-content"]');
    await providerMenu.waitForDisplayed();
    // Outer-frame coordinates are not stable during the entrance zoom; wait for the menu's own animation to finish before checking alignment.
    await browser.waitUntil(() =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[role="menu"]')).every((menu) =>
          menu.getAnimations().every((animation) => animation.playState === "finished"),
        ),
      ),
    );
    const providerBounds = await browser.execute(() => {
      const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]')!;
      const rect = menu.getBoundingClientRect();
      return {
        inside: rect.left >= 0 && rect.right <= document.documentElement.clientWidth,
        overflow: menu.scrollWidth > menu.clientWidth,
        topSafe: rect.top >= 11,
        aligned:
          Math.abs(
            rect.top -
              document.querySelector('[data-slot="dropdown-menu-content"]')!.getBoundingClientRect()
                .top,
          ) <= 1,
        listOverflow: getComputedStyle(menu.querySelector("[data-composer-provider-list]")!)
          .overflowY,
      };
    });
    expect(providerBounds.inside).toBe(true);
    expect(providerBounds.overflow).toBe(false);
    expect(providerBounds.topSafe).toBe(true);
    expect(providerBounds.aligned).toBe(true);
    expect(providerBounds.listOverflow).toBe("auto");
    expect(
      await browser.execute(() =>
        getComputedStyle(
          document.querySelector('[data-slot="dropdown-menu-sub-content"]')!,
        ).getPropertyValue("app-region"),
      ),
    ).toBe("no-drag");

    const manage = $('[data-model-footer-action="manage-models"]');
    await manage.waitForDisplayed();
    const badgeGaps = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="menuitemradio"] [data-provider-access-badge]',
        ),
      ).map((badge) => {
        const name = badge.previousElementSibling!;
        const range = document.createRange();
        range.selectNodeContents(name);
        return badge.getBoundingClientRect().left - range.getBoundingClientRect().right;
      }),
    );
    expect(badgeGaps.length).toBeGreaterThan(0);
    for (const gap of badgeGaps) expect(gap).toBeLessThanOrEqual(9);
    await manage.click();
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await waitForNoComposerPickerOpen("menu closed after returning from model settings");
  });

  it("completed task 的 picker 不跨 scope 自动弹到新 draft", async () => {
    await selectV4TaskById(await ensureCompletedTask());
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
  it("model tooltip describes the action and closes when the menu opens", async () => {
    await ensureCompletedTask();
    const trigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
    await browser.performActions([
      {
        type: "pointer",
        id: "tooltip-mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, x: 1, y: 1 }],
      },
    ]);
    await trigger.moveTo();
    const tooltip = $('[data-slot="tooltip-content"]');
    await tooltip.waitForDisplayed();
    expect(await tooltip.getText()).toMatch(/Select model|选择模型/);
    expect(await tooltip.getText()).not.toContain(" · ");
    expect(await tooltip.$("kbd").isExisting()).toBe(true);
    await trigger.click();
    await waitForOnlyComposerPickerOpen("model", "tooltip to model menu");
    await tooltip.waitForDisplayed({ reverse: true });
    await closeComposerPicker();
  });
  it("draft: dismisses with one outside click after using the effort slider", async () => {
    await ensureCompletedTask();
    // An unbound draft has no config ACK, so consecutive tuning keeps the popover open; the existing-session gate is verified by CPG02.
    await startNewV4Draft();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    for (const gesture of ["click", "drag"]) {
      await openComposerPicker("model");
      try {
        const slider = $('[data-testid="composer-thought-slider"]');
        const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
        expect(levels.length).toBeGreaterThan(1);
        await slider.click();
        // The click itself may trigger a catalog reread; send Home only after the real interaction gate recovers, so the keypress is not swallowed.
        await browser.waitUntil(
          async () => (await slider.getAttribute("aria-disabled")) === "false",
          { timeout: 15000 },
        );
        await browser.keys("Home");
        await browser.waitUntil(async () => (await getV4ModelConfig()).thought === levels[0]);
        const before = await getV4ModelConfig();
        const targetIndex = gesture === "click" ? 1 : levels.length - 1;
        // The midpoint may fall exactly on the boundary between two discrete levels; click the target level's center to avoid pixel rounding ambiguity.
        const rect = await browser.execute((target) => {
          const input = document.querySelector<HTMLInputElement>(
            '[data-testid="composer-thought-slider"]',
          )!;
          const bounds = input.getBoundingClientRect();
          const position = (index: number) =>
            Math.round(bounds.left + 14 + ((bounds.width - 28) * index) / Number(input.max));
          return {
            x: position(Number(input.value)),
            y: Math.round(bounds.top + bounds.height / 2),
            end: position(target),
          };
        }, targetIndex);
        await browser.performActions([
          {
            type: "pointer",
            id: "dismiss-slider",
            parameters: { pointerType: "mouse" },
            actions: [
              {
                type: "pointerMove",
                duration: 0,
                x: gesture === "click" ? rect.end : rect.x,
                y: rect.y,
              },
              { type: "pointerDown", button: 0 },
              ...(gesture === "drag"
                ? [{ type: "pointerMove" as const, duration: 150, x: rect.end, y: rect.y }]
                : []),
              { type: "pointerUp", button: 0 },
            ],
          },
        ]);
        await browser.releaseActions();
        // First prove the real gesture has adjusted the level, so a dead slider does not produce a false pass by only checking the menu closed.
        await browser.waitUntil(
          async () =>
            Number(await slider.getValue()) === targetIndex &&
            (await getV4ModelConfig()).thought === levels[targetIndex],
          { timeout: 15000, timeoutMsg: `${gesture} did not commit the target effort` },
        );
        expect(await getV4ModelConfig()).toMatchObject({
          provider: before.provider,
          model: before.model,
          thought: levels[targetIndex],
        });
        await browser.waitUntil(
          async () => {
            const value = await $('[data-testid="composer-thought-value"] [title]');
            return (await value.getText()) === (await slider.getAttribute("aria-valuetext"));
          },
          { timeout: 5000, timeoutMsg: "rolling effort label did not settle on the current level" },
        );
        await waitForOnlyComposerPickerOpen("model", "slider interaction");
        await browser.performActions([
          {
            type: "pointer",
            id: "outside-click",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", duration: 0, x: 4, y: 100 },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ]);
        await browser.releaseActions();
        await waitForNoComposerPickerOpen(`one outside click after ${gesture}`);
        expect(await getV4ModelConfig()).toMatchObject({
          provider: before.provider,
          model: before.model,
          thought: levels[targetIndex],
        });
      } finally {
        await browser.releaseActions();
        if (
          (await $('[data-testid="chat-model-select-trigger"]').getAttribute("aria-expanded")) ===
          "true"
        )
          await closeComposerPicker();
      }
    }
  });
  it("draft: keeps the open model picker responsive when the composer shrinks and expands", async () => {
    await ensureCompletedTask();
    // An unbound draft has no config ACK, so consecutive tuning keeps the popover open; the existing-session gate is verified by CPG02.
    await startNewV4Draft();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    await openComposerPicker("model");
    const trigger = await $('[data-testid="chat-model-select-trigger"]');
    const slider = await $('[data-testid="composer-thought-slider"]');
    const menu = await $('[role="menu"]');
    const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
    expect(levels.length).toBeGreaterThan(1);
    // A mouse left inside the menu triggers Radix's pointerleave focus rule as the overlay moves; isolate the resize with a keyboard scenario.
    await browser.performActions([
      {
        type: "pointer",
        id: "resize-pointer",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, x: 4, y: 100 }],
      },
    ]);
    await browser.releaseActions();
    await browser.keys("End");
    await browser.waitUntil(() => slider.isFocused(), {
      timeout: 5000,
      timeoutMsg: "keyboard did not focus effort slider",
    });
    await browser.keys("Home");
    await browser.waitUntil(async () => (await getV4ModelConfig()).thought === levels[0]);
    let expectedConfig = await getV4ModelConfig();
    const resizeToolbar = async (width: string) =>
      browser.execute((value) => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-testid="chat-model-select-trigger"]',
        )!;
        const root = trigger.closest<HTMLElement>(
          "[data-composer-trailing-actions]",
        )!.parentElement!;
        root.style.width = value;
      }, width);
    try {
      for (const width of ["240px", ""]) {
        await resizeToolbar(width);
        await browser.waitUntil(
          async () =>
            browser.execute((compact) => {
              const trigger = document.querySelector<HTMLElement>(
                '[data-testid="chat-model-select-trigger"]',
              )!;
              const root = trigger.closest<HTMLElement>(
                "[data-composer-trailing-actions]",
              )!.parentElement!;
              const leading = root
                .querySelector<HTMLElement>("[data-composer-leading-content]")!
                .getBoundingClientRect();
              const trailing = root
                .querySelector<HTMLElement>("[data-composer-trailing-actions]")!
                .getBoundingClientRect();
              const label = trigger.querySelector<HTMLElement>("[data-composer-open-label]")!;
              const icon = trigger.querySelector<HTMLElement>("[data-composer-open-icon]")!;
              return (
                trigger.getAttribute("aria-expanded") === "true" &&
                leading.right <= trailing.left &&
                (compact
                  ? trigger.getBoundingClientRect().width < 128 &&
                    getComputedStyle(label).display === "none" &&
                    getComputedStyle(icon).display !== "none" &&
                    getComputedStyle(
                      trigger.querySelector<HTMLElement>("[data-composer-open-thought]")!,
                    ).display !== "none" &&
                    !trigger.querySelector("[data-composer-open-chevron]")
                  : trigger.getBoundingClientRect().width >= 128 &&
                    getComputedStyle(label).display !== "none" &&
                    getComputedStyle(icon).display === "none")
              );
            }, Boolean(width)),
          { timeout: 5000, timeoutMsg: `open picker failed to fit ${width || "restored width"}` },
        );
        // Checking only aria-expanded would miss a rebuilt menu or lost focus; keep the WebDriver node identity and verify the keyboard path.
        expect((await $('[data-testid="chat-model-select-trigger"]')).elementId).toBe(
          trigger.elementId,
        );
        expect((await $('[data-testid="composer-thought-slider"]')).elementId).toBe(
          slider.elementId,
        );
        expect((await $('[role="menu"]')).elementId).toBe(menu.elementId);
        expect(await slider.isFocused()).toBe(true);
        expect(await getV4ModelConfig()).toEqual(expectedConfig);
        if (width) {
          await browser.keys("End");
          await browser.waitUntil(
            async () =>
              (await getV4ModelConfig()).thought === levels.at(-1) &&
              (await $('[data-testid="composer-thought-meter"]').getAttribute("data-progress")) ===
                "100",
            { timeout: 15000, timeoutMsg: "compact picker lost keyboard effort updates" },
          );
          expect(await $('[data-testid="composer-thought-meter"]').isDisplayed()).toBe(true);
          expectedConfig = { ...expectedConfig, thought: levels.at(-1)! };
          expect(await getV4ModelConfig()).toEqual(expectedConfig);
        }
      }
      await resizeToolbar("240px");
      await closeComposerPicker();
      await openComposerPicker("model");
      await waitForOnlyComposerPickerOpen("model", "reopen at compact width");
      expect(await $("[data-composer-open-icon]").isDisplayed()).toBe(true);
      expect(await $('[data-testid="composer-thought-meter"]').isDisplayed()).toBe(true);
      expect(await $("[data-composer-open-chevron]").isExisting()).toBe(false);
      expect(await $("[data-composer-open-label]").isDisplayed()).toBe(false);
      expect((await trigger.getSize()).width).toBeLessThan(128);
      expect(await getV4ModelConfig()).toEqual(expectedConfig);
    } finally {
      await resizeToolbar("");
      await closeComposerPicker();
    }
  });
  it("CPG02: while the config ACK is pending, keep the panel and disable config; pending is independent across sessions", async function () {
    this.timeout(120000);
    await ensureCompletedTask();
    await seedAckProvider();
    const taskA = completedTaskId!;
    const marker = "E2E_PROVIDER_PENDING_SEND_CROSS_SESSION";
    await startNewV4Draft();
    await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
    await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
    const taskB = (
      await waitForV4Pane(
        (p) => !p.canStop && Boolean(p.sessionId),
        "session B not finished",
        45000,
      )
    ).sessionId!;
    await switchV4Model(ACK_PROVIDER, "GLM-5.3", "max");
    await selectV4TaskById(taskA);
    await switchV4Model(ACK_PROVIDER, "GLM-5.3", "max");
    await setV4ComposerText(marker);
    await browser.execute(() => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<() => void> = [];
      const probe = {
        count: 0,
        releaseOne() {
          held.shift()?.();
        },
        restore() {
          MessagePort.prototype.postMessage = original;
          held.splice(0).forEach((send) => send());
        },
      };
      (window as Window & { __configAckProbe?: typeof probe }).__configAckProbe = probe;
      MessagePort.prototype.postMessage = function (
        ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
      ) {
        const data = args[0];
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
        const wire = bytes ? new TextDecoder().decode(bytes) : "";
        // Control sending of the real config RPC so the caller keeps waiting for the ACK; do not fabricate a session or receipt.
        if (
          wire.includes("sendConversationCommandV4") &&
          wire.includes('"type":"switchModelConfig"')
        ) {
          probe.count++;
          held.push(() => Reflect.apply(original, this, args));
          return;
        }
        Reflect.apply(original, this, args);
      };
    });
    const count = () =>
      browser.execute(
        () => (window as Window & { __configAckProbe?: { count: number } }).__configAckProbe!.count,
      );
    const release = () =>
      browser.execute(() =>
        (
          window as Window & { __configAckProbe?: { releaseOne(): void } }
        ).__configAckProbe!.releaseOne(),
      );
    const changeThought = async () => {
      await openComposerPicker("model");
      await browser.execute(() =>
        document
          .querySelector<HTMLInputElement>('[data-testid="composer-thought-slider"]')
          ?.focus(),
      );
      await browser.keys("Home");
    };
    const expectLocked = async () => {
      const trigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
      await browser.waitUntil(async () => !(await trigger.isEnabled()), {
        timeout: 5000,
        timeoutMsg: "model selection still allowed while the ACK is in flight",
      });
      // Cross-session navigation may close the menu; the ACK from the current action must not close it.
      if ((await trigger.getAttribute("aria-expanded")) === "true") {
        expect(
          await $('[data-testid="composer-thought-slider"]').getAttribute("aria-disabled"),
        ).toBe("true");
        expect(
          await $('[data-testid="composer-provider-trigger"]').getAttribute("aria-disabled"),
        ).toBe("true");
        expect(
          await $('[data-testid^="chat-model-select-item-"]').getAttribute("aria-disabled"),
        ).toBe("true");
      }
    };
    try {
      await changeThought();
      await browser.waitUntil(async () => (await count()) === 1, { timeout: 10000 });
      await expectLocked();
      await waitForOnlyComposerPickerOpen(
        "model",
        "keep the panel while the slider ACK is in flight",
      );
      await browser.keys(["Control", "t"]);
      await browser.keys(["Control", "m"]);
      await expectLocked();
      expect(await count()).toBe(1);
      await closeComposerPicker();
      await selectV4TaskById(taskB);
      await changeThought();
      await browser.waitUntil(async () => (await count()) === 2, {
        timeout: 10000,
        timeoutMsg: "B blocked by A's barrier",
      });
      await expectLocked();
      await waitForOnlyComposerPickerOpen(
        "model",
        "B keep the panel while the slider ACK is in flight",
      );
      await closeComposerPicker();
      await selectV4TaskById(taskA);
      await expectLocked();
      await selectV4TaskById(taskB);
      await release();
      await expectPersistedThought(taskA, "high");
      await expectLocked();
      await release();
      await expectPersistedThought(taskB, "high");
      await browser.waitUntil(async () => (await getV4ModelConfig()).thought === "high", {
        timeout: 10000,
      });
      expect(await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).isEnabled()).toBe(true);
      await selectV4TaskById(taskA);
      await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").includes(marker), {
        timeout: 10000,
        timeoutMsg: "draft body lost after returning to A",
      });
      const displayed = await getV4ModelConfig();
      const send = $('[data-testid="v4-composer-send"]');
      await send.waitForClickable({ timeout: 10000 });
      await send.click();
      const capture = await waitForUpstreamNetworkCapture(marker);
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await writeFile(
          join(artifactDir, "cross-session-ack-request.json"),
          JSON.stringify(
            {
              sessionId: taskA,
              marker,
              displayed,
              expectedThought: "high",
              url: capture.url,
              statusCode: capture.statusCode,
              request: capture.requestJson,
            },
            null,
            2,
          ),
        );
      assertUpstreamRequestCapture(capture, { expectedText: marker, model: "GLM-5.3" });
      assertUpstreamThoughtLevelCapture(capture, "high");
      expect(displayed.thought).toBe("high");
    } finally {
      await browser.execute(() =>
        (window as Window & { __configAckProbe?: { restore(): void } }).__configAckProbe?.restore(),
      );
    }
  });
  it("CPG01: mobile remote switches a same-named Provider, does not send while pending, uses the target Provider after completion", async function () {
    this.timeout(120000);
    await ensureCompletedTask();
    // A and B use the same workspace; mobile navigation rebuilds the bridge, so a late receipt must be recovered from the session.
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
    await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
    completedTaskId = (
      await waitForV4Pane((p) => !p.canStop && Boolean(p.sessionId), "mobile A not finished", 45000)
    ).sessionId!;
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL, "high");
    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint) throw new Error("CPG01 is missing the mobile fixture");
    await $(
      'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
    ).waitForClickable({ timeout: 10000 });
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    const held: Array<() => void> = [];
    let holding = false;
    let holdConfig = false;
    let holdConfigReply = false;
    let replyBridge: string | null = null;
    let configs = 0;
    let sends = 0;
    const release = () => {
      holding = false;
      holdConfig = false;
      holdConfigReply = false;
      replyBridge = null;
      held.splice(0).forEach((send) => send());
    };
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
        const server = route.connectToServer();
        route.onMessage((message) => {
          const payload = JSON.parse(String(message)).payload;
          const wire =
            typeof payload?.dataBase64 === "string"
              ? Buffer.from(payload.dataBase64, "base64").toString("utf8")
              : "";
          if (wire.includes("sendConversationCommandV4") && wire.includes('"type":"sendText"'))
            sends++;
          const isConfig =
            wire.includes("sendConversationCommandV4") &&
            wire.includes('"type":"switchModelConfig"');
          if (isConfig) configs++;
          if (isConfig && holdConfigReply && wire.includes(completedTaskId!))
            replyBridge = payload.bridgeSessionId;
          if (
            (holdConfig && isConfig && wire.includes(completedTaskId!)) ||
            (holding && wire.includes("model-selection") && wire.includes("getView"))
          ) {
            held.push(() => server.send(message));
          } else server.send(message);
        });
        server.onMessage((message) => {
          const payload = JSON.parse(String(message)).payload;
          if (replyBridge && payload?.bridgeSessionId === replyBridge && payload.dataBase64)
            held.push(() => route.send(message));
          else route.send(message);
        });
      });
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/provider-gate",
        caseMarker: "CPG01",
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      await showMobileTaskHome(page);
      const toggles = page.getByTestId("virtual-project-toggle");
      for (let i = 0; i < (await toggles.count()); i++) {
        const toggle = toggles.nth(i);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      }
      await page.getByTestId(`task-item-${completedTaskId}`).first().click();
      const input = page.getByTestId(TID_V4_COMPOSER_INPUT);
      await input.waitFor();
      await input.fill("E2E_PROVIDER_PENDING_SEND_MOBILE");
      const readDraft = () =>
        input.evaluate((element) =>
          element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
            ? element.value
            : (element.textContent ?? ""),
        );
      await browser.waitUntil(
        async () =>
          (await readDraft()).includes("E2E_PROVIDER_PENDING_SEND_MOBILE") &&
          (await page.getByTestId("v4-composer-send").isEnabled()),
        { timeout: 30000 },
      );
      holding = true;
      await page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER).click();
      await page.getByTestId("composer-provider-trigger").click();
      await page
        .locator(`[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`)
        .click();
      await browser.waitUntil(() => held.length > 0, { timeout: 10000 });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const send = page.getByTestId("v4-composer-send");
      expect(await send.isDisabled()).toBe(true);
      await input.press("Enter");
      expect(sends).toBe(0);
      expect(await readDraft()).toContain("E2E_PROVIDER_PENDING_SEND_MOBILE");
      release();
      await browser.waitUntil(() => send.isEnabled(), { timeout: 30000 });
      // Mobile level-only changes must also commit the session before sending, not only update the local draft.
      await page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER).click();
      const thoughtSlider = page.getByTestId("composer-thought-slider");
      const thoughtLevels = JSON.parse(
        (await thoughtSlider.getAttribute("data-levels")) ?? "[]",
      ) as string[];
      await thoughtSlider.focus();
      await thoughtSlider.press("Home");
      await expectPersistedThought(completedTaskId!, thoughtLevels[0]!);
      await page.keyboard.press("Escape");
      // Mobile config ACK gate: keep the panel, disable config and shortcuts, and do not send until confirmed.
      const modelTrigger = page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER);
      await modelTrigger.click();
      holdConfig = true;
      const configsBefore = configs;
      await thoughtSlider.focus();
      await thoughtSlider.press("End");
      await browser.waitUntil(() => held.length === 1, { timeout: 10000 });
      await browser.waitUntil(() => modelTrigger.isDisabled(), { timeout: 5000 });
      expect(await modelTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(await thoughtSlider.getAttribute("aria-disabled")).toBe("true");
      await page.keyboard.press("Control+t");
      await page.keyboard.press("Control+m");
      expect(configs).toBe(configsBefore + 1);
      expect(await send.isDisabled()).toBe(true);
      release();
      await expectPersistedThought(completedTaskId!, thoughtLevels.at(-1)!);
      await browser.waitUntil(() => send.isEnabled(), { timeout: 30000 });
      expect(await modelTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(await thoughtSlider.getAttribute("aria-disabled")).toBe("false");
      await page.keyboard.press("Escape");
      const repliesBefore = (await page.locator('[data-testid="v4-timeline"]').innerText()).split(
        "PROVIDER_PENDING_SEND_OK",
      ).length;
      await send.click();
      await browser.waitUntil(
        async () =>
          (await page.locator('[data-testid="v4-timeline"]').innerText()).split(
            "PROVIDER_PENDING_SEND_OK",
          ).length > repliesBefore,
        { timeout: 45000 },
      );
      expect(sends).toBe(1);
      await waitForV4Pane((pane) => !pane.canStop, "CPG01 mobile request did not finish", 30000);
      const db = new DatabaseSync(
        join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "select provider_id as provider, model_id as model from model_usage where session_id = ? and query_source = 'main_turn' order by started_at desc limit 1",
            )
            .get(completedTaskId!),
        ).toMatchObject({
          provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
          model: UPSTREAM_ALTERNATE_MODEL,
        });
      } finally {
        db.close();
      }
      // Mobile also keeps the unsent body; release the original session config only after leaving, then return and capture the actual request.
      await seedAckProvider();
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
      await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
      const taskB = (
        await waitForV4Pane(
          (p) => !p.canStop && Boolean(p.sessionId),
          "手机验证 session B not finished",
          45000,
        )
      ).sessionId!;
      await modelTrigger.click();
      await page.getByTestId("composer-provider-trigger").click();
      await page.locator(`[data-model-provider-key="registry-provider:${ACK_PROVIDER}"]`).click();
      await browser.waitUntil(
        async () => (await thoughtSlider.getAttribute("aria-disabled")) === "false",
        { timeout: 15000 },
      );
      await thoughtSlider.focus();
      await thoughtSlider.press("End");
      await expectPersistedThought(completedTaskId!, "max");
      await page.keyboard.press("Escape");
      const marker = "E2E_PROVIDER_PENDING_SEND_CROSS_SESSION_MOBILE";
      await input.fill(marker);
      await modelTrigger.click();
      // Release the command; only delay A bridge's downstream config receipt and projection, so the command is not resent to a destroyed bridge.
      holdConfigReply = true;
      await thoughtSlider.focus();
      await thoughtSlider.press("Home");
      await expectPersistedThought(completedTaskId!, "high");
      await browser.waitUntil(() => held.length > 0, { timeout: 10000 });
      expect(await modelTrigger.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      const openTask = async (id: string) => {
        await showMobileTaskHome(page);
        const groups = page.getByTestId("virtual-project-toggle");
        for (let i = 0; i < (await groups.count()); i++) {
          if ((await groups.nth(i).getAttribute("aria-expanded")) !== "true")
            await groups.nth(i).click();
        }
        await page.getByTestId(`task-item-${id}`).first().click();
        try {
          await input.waitFor({ timeout: 15000 });
        } catch (error) {
          const dir = process.env.ZCODE_E2E_ARTIFACT_DIR;
          if (dir)
            await writeFile(
              join(dir, "cross-session-mobile-navigation.txt"),
              `${id} held=${held.length}\n${await page.locator("body").innerText()}`,
            );
          throw error;
        }
      };
      await openTask(taskB);
      release();
      await expectPersistedThought(completedTaskId!, "high");
      await openTask(completedTaskId!);
      await browser.waitUntil(async () => (await readDraft()).includes(marker), {
        timeout: 10000,
        timeoutMsg: "手机draft body lost after returning to A",
      });
      await send.click();
      const capture = await waitForUpstreamNetworkCapture(marker);
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await writeFile(
          join(artifactDir, "cross-session-ack-mobile-request.json"),
          JSON.stringify(
            {
              sessionId: completedTaskId,
              marker,
              expectedThought: "high",
              url: capture.url,
              statusCode: capture.statusCode,
              request: capture.requestJson,
            },
            null,
            2,
          ),
        );
      assertUpstreamRequestCapture(capture, { expectedText: marker, model: "GLM-5.3" });
      assertUpstreamThoughtLevelCapture(capture, "high");
    } finally {
      release();
      await chrome.close();
    }
  });
  for (const [width, changeScope] of [
    [1280, false],
    [430, false],
    [1280, true],
  ] as const) {
    it(`CPG01: at ${width}px, switching Provider for a same-named model blocks sending and keeps the draft${changeScope ? " (switching session)" : ""}`, async function () {
      this.timeout(120000);
      await ensureCompletedTask();
      let nextTaskId: string | undefined;
      if (changeScope) {
        await startNewV4Draft();
        await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
        await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
        const next = await waitForV4Pane(
          (pane) => !pane.canStop && Boolean(pane.sessionId) && pane.sessionId !== "draft",
          "scope backfill check did not create session B",
          45000,
        );
        nextTaskId = next.sessionId!;
      }
      await selectV4TaskById(completedTaskId!);
      await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL, "high");
      await browser.electron.execute((electron, size) => {
        electron.BrowserWindow.getAllWindows()
          .find((window) => window.isVisible())
          ?.setSize(size, 900);
      }, width);
      await setV4ComposerText(`E2E_PROVIDER_PENDING_SEND_${width}`);
      await browser.execute(() => {
        const original = MessagePort.prototype.postMessage;
        const held: Array<() => void> = [];
        let holding = true;
        const probe = {
          held: 0,
          sends: 0,
          allowNewRequests() {
            holding = false;
          },
          release() {
            holding = false;
            held.splice(0).forEach((send) => send());
          },
          restore() {
            probe.release();
            MessagePort.prototype.postMessage = original;
          },
        };
        (window as Window & { __providerPendingProbe?: typeof probe }).__providerPendingProbe =
          probe;
        MessagePort.prototype.postMessage = function (
          ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
        ) {
          const data = args[0];
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : null;
          const wire = bytes ? new TextDecoder().decode(bytes) : "";
          const forward = () => Reflect.apply(original, this, args);
          if (wire.includes("sendConversationCommandV4") && wire.includes('"type":"sendText"'))
            probe.sends++;
          // Suspend the real catalog RPC without changing the model selection, ACK, or server state.
          if (holding && wire.includes("model-selection") && wire.includes("getView")) {
            probe.held++;
            held.push(forward);
            return;
          }
          forward();
        };
      });
      const readProbe = () =>
        browser.execute(() => {
          const probe = (
            window as Window & { __providerPendingProbe?: { held: number; sends: number } }
          ).__providerPendingProbe!;
          return { held: probe.held, sends: probe.sends };
        });
      try {
        await openComposerPicker("model");
        await $('[data-testid="composer-provider-trigger"]').click();
        await $(
          `[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`,
        ).click();
        await browser.waitUntil(async () => (await readProbe()).held > 0, { timeout: 10000 });
        await closeComposerPicker();
        const send = $('[data-testid="v4-composer-send"]');
        await browser.waitUntil(async () => !(await send.isEnabled()), {
          timeout: 5000,
          timeoutMsg: "sending still allowed while Provider refreshes",
        });
        await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).click();
        await browser.keys("Enter");
        expect((await readProbe()).sends).toBe(0);
        expect(await getV4ComposerText()).toContain("E2E_PROVIDER_PENDING_SEND");
        if (nextTaskId) {
          await browser.execute(() =>
            (
              window as Window & { __providerPendingProbe?: { allowNewRequests(): void } }
            ).__providerPendingProbe!.allowNewRequests(),
          );
          await selectV4TaskById(nextTaskId);
          await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL, "high");
          await setV4ComposerText(`E2E_PROVIDER_PENDING_SEND_${width}`);
          await openComposerPicker("model");
          await $('[data-testid="composer-provider-trigger"]').click();
          await $(
            `[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`,
          ).click();
          await closeComposerPicker();
          await browser.waitUntil(async () => await send.isEnabled(), {
            timeout: 30000,
            timeoutMsg: "pending not cleared after switching Provider again in session B",
          });
        }
        await browser.execute(() =>
          (
            window as Window & { __providerPendingProbe?: { release(): void } }
          ).__providerPendingProbe!.release(),
        );
        await browser.waitUntil(async () => await send.isEnabled(), { timeout: 30000 });
        expect(await getV4ModelConfig()).toMatchObject({
          provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
          model: UPSTREAM_ALTERNATE_MODEL,
        });
        const repliesBefore = (await getV4PaneSnapshot()).timelineText.split(
          "PROVIDER_PENDING_SEND_OK",
        ).length;
        await send.click();
        const pane = await waitForV4Pane(
          (value) =>
            !value.canStop &&
            value.timelineText.split("PROVIDER_PENDING_SEND_OK").length > repliesBefore,
          "CPG01 new request did not finish",
          45000,
        );
        expect((await readProbe()).sends).toBe(1);
        // Node SQLite only offers a sync interface; read the owner of one actual request, and do not replace the request assertion with the toolbar display.
        const db = new DatabaseSync(
          join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
          { readOnly: true },
        );
        try {
          expect(
            db
              .prepare(
                "select provider_id as provider, model_id as model, status from model_usage where session_id = ? and query_source = 'main_turn' order by started_at desc limit 1",
              )
              .get(pane.sessionId!),
          ).toMatchObject({
            provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
            model: UPSTREAM_ALTERNATE_MODEL,
            status: "completed",
          });
        } finally {
          db.close();
        }
      } finally {
        await browser.electron.execute((electron) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => window.isVisible())
            ?.setSize(1280, 900);
        });
        await browser.execute(() =>
          (
            window as Window & { __providerPendingProbe?: { restore(): void } }
          ).__providerPendingProbe?.restore(),
        );
      }
    });
  }
});
