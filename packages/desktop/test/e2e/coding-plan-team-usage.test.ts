import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_LOGIN_TRIGGER,
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  TID_SETTINGS_USAGE_TAB,
  TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
  type ProviderFamilyConnectionSelection,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  readModelProviders,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "./helpers/desktop-app.js";
import { waitForProviderConfigPolling } from "./helpers/provider-config-polling.js";
import { selectRegistryProviderModelById } from "./helpers/upstream-provider.js";
import { seedPersistedModelSelection } from "./helpers/model-provider-restart.js";
import { sel } from "./helpers/selectors.js";
import { skipOccupationOnboardingIfPresent } from "./helpers/occupation-onboarding.js";

// Why the fix: WDIO injects an isolated HOME per run, but os.homedir() in a Node process does
// not change dynamically with the environment variable. Sticking with homedir() would write
// scenario settings and the provider seed to the developer machine's ~/.zcode while Electron
// reads this run's isolated HOME; also, the new Personal Config file name is
// provider_config.json, not the old config.json. Reuse desktop-app's path contract uniformly to
// ensure the test writes and the app read the same fixture.
const E2E_APP_DATA_PATHS = getE2EAppDataPaths();
const E2E_STORAGE_ROOT = E2E_APP_DATA_PATHS.storageRoot;
const SETTINGS_FILE = join(E2E_APP_DATA_PATHS.appDataDir, "setting.json");
const CREDENTIALS_FILE = E2E_APP_DATA_PATHS.credentialsFile;
const TEAM_PLAN_KEY = "team:bigmodel:product-team-a:org-team-a:proj-team-a";
const PERSONAL_PLAN_KEY = "account:bigmodel-individual-coding-plan";
const PERSONAL_PLAN_CONNECTION_KEY = `coding-plan:${PERSONAL_PLAN_KEY}`;
const BIGMODEL_ACCOUNT_NAV_KEY = `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`;
// Matches this round's Builtin catalog; the old GLM-5.2 is no longer among the Account Provider's selectable models.
const BIGMODEL_E2E_MODEL = "GLM-5.3";

type CodingPlanScenario = "personalOnly" | "teamOnly" | "both";
type CodingPlanFaultMode =
  | "none"
  | "optionalActivity"
  | "quotaBusinessFailure"
  | "quotaFailure"
  | "startBalance"
  | "startBalanceFailure";
type CodingPlanResetScenario =
  | "none"
  | "emptyThenGrant"
  | "existingMultiple"
  | "fiveHourUse"
  | "multiFiveHourUse"
  | "multiFiveHourUseLagging"
  | "urgentOpportunity";

describe("Team Plan 设置与使用统计 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CTP-13: Start balance 限流显示重试，恢复后展示套餐", async function () {
    this.timeout(120000);
    const evidenceDir =
      process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts", "coding-plan");
    await mkdir(evidenceDir, { recursive: true });
    await prepareScenario(
      "personalOnly",
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      "startBalanceFailure",
    );
    await openModelProviderSettings();
    await clickVisibleTestIdByDom(
      testId(
        TID_MODEL_PROVIDER_NAV_ITEM,
        `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
      ),
      {
        timeout: 10000,
        timeoutMsg: "BigModel 入口缺失",
      },
    );
    await assertBodyTextIncludesAny(["Retry", "重试"]);
    await assertBodyTextIncludesAny(["Fetch failed", "获取失败"]);
    await browser.saveScreenshot(join(evidenceDir, "coding-plan-start-failure.png"));
    await assertBodyTextExcludes([
      "Could not verify Coding Plan entitlement. Connect again and retry.",
      "暂时无法确认 Coding Plan 权益，请重新连接后再试。",
    ]);
    await setMockScenario("personalOnly", "startBalance");
    // A failed result also has a clear one-second reuse window; verify the user's retry recovery after the window ends.
    await browser.pause(1000);
    await clickVisibleButtonByText(["Retry", "重试"]);
    await assertBodyTextIncludes(["GLM-5-Turbo"]);
    await browser.waitUntil(
      async () =>
        !(await browser.execute(() => document.body.innerText)).match(/Fetch failed|获取失败/),
      { timeout: 15000, timeoutMsg: "重试后失败状态未恢复" },
    );
    await browser.saveScreenshot(join(evidenceDir, "coding-plan-start-recovered.png"));
  });

  it("CTP-01: 登录后不进入设置页也应获取 Team Plan pricing", async function () {
    this.timeout(90000);

    await prepareScenario("both", TEAM_PLAN_KEY);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);

    await waitForMockRequest(
      (request) => request.path.endsWith("/subscription/enterprise/v2/pricing"),
      "未在不进入设置页时请求企业套餐 pricing",
    );
    await expect($(sel(TID_SETTINGS_PAGE))).not.toBeDisplayed();
  });

  it("CTP-02: 设置页连接方式应展示个人 Coding Plan 和 Team Plan", async function () {
    this.timeout(120000);

    await prepareScenario("both", PERSONAL_PLAN_KEY);
    await openModelProviderSettings();
    await clickVisibleTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
      timeout: 30000,
      timeoutMsg: "BigModel 供应商导航项没有出现",
    });
    await assertConnectionModeOptionsInclude([
      {
        key: PERSONAL_PLAN_CONNECTION_KEY,
        labels: ["Individual Plan", "个人套餐"],
      },
      { key: TEAM_PLAN_KEY, labels: ["Team Org"] },
    ]);

    await selectConnectionModeOptionByTestId(
      testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, TEAM_PLAN_KEY),
      "Team Org",
    );
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        const selection = settings.providerFamilyConnectionSelections?.bigmodel;
        return (
          selection?.kind === "team-coding-plan" &&
          selection.productId === "product-team-a" &&
          selection.organizationId === "org-team-a" &&
          selection.projectId === "proj-team-a"
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "选择 Team Plan 后没有写入结构化 BigModel connection selection",
      },
    );
  });

  for (const locale of ["zh-CN", "en-US"] as const) {
    it(`CTP-02B: 侧栏头像旁应显示当前已确认的 Team Plan 标签（${locale}）`, async function () {
      this.timeout(120000);

      await prepareScenario("teamOnly", TEAM_PLAN_KEY, "none", "none", locale);
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);

      const profileTrigger = $(sel(TID_LOGIN_TRIGGER));
      await profileTrigger.waitForDisplayed({
        timeout: 30000,
        timeoutMsg: "侧栏头像入口没有出现",
      });
      // The English UI's plan label is Team; assert only the badge itself to avoid a false pass when the username contains team text.
      const teamLabel = locale === "zh-CN" ? "团队" : "Team";
      const badge = profileTrigger.$(`span[title="${teamLabel}"]`);
      await badge.waitForDisplayed({ timeout: 30000 });
      await expect(badge).toHaveText(teamLabel);
    });
  }

  it("CTP-03: 用户头像菜单应进入 Team Plan 使用统计并请求团队额度", async function () {
    this.timeout(120000);

    await prepareScenario("teamOnly", TEAM_PLAN_KEY);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
    await openSidebarUsageStats();

    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
    await clickUsageCodingPlanTab(TEAM_PLAN_KEY);
    await assertBodyTextIncludes(["Team Org", "90%"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/usage/quota/limit") &&
        request.query.type === "2" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "头像菜单未按 Team Plan 请求 quota/limit?type=2",
    );
  });

  it("CTP-04: 使用统计编程套餐应显示 Team Plan 额度、模型用量和工具用量", async function () {
    this.timeout(120000);

    await prepareScenario("teamOnly", TEAM_PLAN_KEY);
    await openUsageCodingPlanTab(TEAM_PLAN_KEY);

    await assertBodyTextIncludes(["Team Org", "90%", "glm-credit-e2e"]);
    await assertBodyTextIncludesAny(["Models", "模型"]);
    await clickVisibleButtonByText(["Tools", "工具"]);
    await assertBodyTextIncludes(["E2E Search MCP"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "使用统计未按 Team Plan 请求 MODEL credit detail",
    );
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MCP" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "使用统计未按 Team Plan 请求 MCP credit detail",
    );
  });

  it("CTP-04B: 个人套餐应展示 credit activity、明细与性能数据", async function () {
    this.timeout(120000);

    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY);
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await assertBodyTextIncludes(["glm-credit-e2e"]);
    await assertBodyTextIncludesAny(["Credits total", "积分总数"]);
    await clickVisibleButtonByText(["Tools", "工具"]);
    await assertBodyTextIncludes(["E2E Search MCP"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/activity") &&
        request.query.type === "1" &&
        !request.headers["bigmodel-organization"] &&
        !request.headers["bigmodel-project"],
      "个人套餐没有请求隔离的 credit activity",
    );
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL",
      "个人套餐没有请求 MODEL credit detail",
    );
    await waitForMockRequest(
      (request) => request.path.endsWith("/api/monitor/usage/model-performance-day"),
      "个人套餐没有请求 model performance",
    );
  });

  for (const locale of ["zh-CN", "en-US"] as const) {
    it(`CTP-05: 个人/团队套餐组合应跟随当前连接方式展示（${locale}）`, async function () {
      this.timeout(180000);

      await prepareScenario("both", TEAM_PLAN_KEY, "none", "none", locale);
      await openModelProviderSettings();
      await clickVisibleTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
        timeout: 30000,
        timeoutMsg: "BigModel 供应商导航项没有出现",
      });
      await selectConnectionModeOptionByTestId(
        testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, PERSONAL_PLAN_CONNECTION_KEY),
        "个人 Coding Plan",
      );
      await waitForBigModelConnectionSelection("individual-coding-plan");
      await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
      await assertBodyTextIncludes(["70%", "glm-credit-e2e"]);
      // The usage stats personal tab is Individual Plan, not the settings page's left-side Coding Plan.
      const personalTab = $(sel(testId(TID_SETTINGS_USAGE_TAB, `codingPlan:${PERSONAL_PLAN_KEY}`)));
      await expect(personalTab).toHaveText(locale === "zh-CN" ? "个人套餐" : "Individual Plan");
      await expect(personalTab).toHaveAttribute("aria-pressed", "true");
      await assertBodyTextExcludes(["Team Org"]);

      await openModelProviderSettings();
      await clickVisibleTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
        timeout: 30000,
        timeoutMsg: "BigModel 供应商导航项没有出现",
      });
      await selectConnectionModeOptionByTestId(
        testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, TEAM_PLAN_KEY),
        "Team Org",
      );
      await waitForBigModelConnectionSelection("team-coding-plan");
      await openUsageCodingPlanTab(TEAM_PLAN_KEY);
      await assertBodyTextIncludes(["Team Org", "90%", "glm-credit-e2e"]);
    });
  }

  it("CTP-06: 启动恢复 OAuth 时应保留已选择的 Team Plan", async function () {
    this.timeout(120000);

    await prepareScenario("both", TEAM_PLAN_KEY);
    await waitForMockRequest(
      (request) => request.path.endsWith("/subscription/enterprise/v2/pricing"),
      "启动恢复 OAuth 时未请求企业套餐 pricing",
    );
    await browser.waitUntil(
      async () => {
        const selection = (await readSettings()).providerFamilyConnectionSelections?.bigmodel;
        return (
          selection?.kind === "team-coding-plan" &&
          selection.productId === "product-team-a" &&
          selection.organizationId === "org-team-a" &&
          selection.projectId === "proj-team-a"
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "启动恢复 OAuth 后结构化 Team Plan selection 被覆盖",
      },
    );

    await openUsageCodingPlanTab(TEAM_PLAN_KEY);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/usage/quota/limit") &&
        request.query.type === "2" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "启动恢复 OAuth 后使用统计未继续按 Team Plan 请求 quota/limit?type=2",
    );
  });

  it("CTP-07: 切换 7d/30d 应重新请求不同日期窗口且保持当前来源", async function () {
    this.timeout(120000);

    await prepareScenario("both", TEAM_PLAN_KEY);
    await openUsageCodingPlanTab(TEAM_PLAN_KEY);
    await clickVisibleButtonByText(["30 days", "近 30 日"]);
    const thirtyDayRequest = await waitForLatestMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL" &&
        request.query.type === "3" &&
        requestRangeDays(request) === 29,
      "切换 30d 后没有请求新的日期窗口",
    );

    expect(thirtyDayRequest.headers["bigmodel-organization"]).toBe("org-team-a");
    expect(thirtyDayRequest.headers["bigmodel-project"]).toBe("proj-team-a");
    expect(
      daysBetweenMonitorTimes(
        requireQueryValue(thirtyDayRequest, "startTime"),
        requireQueryValue(thirtyDayRequest, "endTime"),
      ),
    ).toBe(29);

    await clickVisibleButtonByText(["7 days", "近 7 日"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL" &&
        request.query.type === "3" &&
        requestRangeDays(request) === 6,
      "切回 7d 后没有恢复对应日期窗口",
    );
  });

  it("CTP-08: 窄窗口下 Usage tabs、range 与热力图仍可操作", async function () {
    this.timeout(120000);
    await setRendererViewport(430, 760);
    try {
      // This case only verifies the narrow-window interaction; it does not additionally bind to
      // the product rule of "when personal + Team both exist, which plan startup recovery auto-
      // selects". Using a single personal entitlement keeps the fixture's responsibility clear.
      await prepareScenario("personalOnly", PERSONAL_PLAN_KEY);
      await setSettingsTheme("zai-dark");
      await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
      await clickVisibleButtonByText(["30 days", "近 30 日"]);
      await assertBodyTextIncludes(["glm-credit-e2e"]);
      await assertBodyTextIncludesAny(["Token activity", "Token 活动"]);
    } finally {
      await setSettingsTheme("zai-light");
      await clearRendererViewport();
    }
  });

  it("CTP-09: activity 可选接口失败不拖垮 quota，刷新后恢复", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "optionalActivity");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await assertBodyTextIncludes(["70%", "glm-credit-e2e"]);
    await assertBodyTextExcludes(["350.7K", "35.1万", "35.1 万"]);
    await setMockScenario("personalOnly", "none");
    await clickVisibleButtonByText(["Refresh", "刷新"]);
    await assertBodyTextIncludesAny(["350.7K", "35.1万", "35.1 万"]);
    await waitForMockRequest(
      (request) => request.path.endsWith("/api/monitor/credit-usage/activity"),
      "activity 恢复后刷新没有重新请求",
    );
  });

  it("CTP-10: Context hover 应按 access freshness 展示同一额度快照", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY);
    await selectBigModelCodingPlanRuntime("individual-coding-plan");
    const trigger = await $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
    await trigger.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "Context usage trigger 没有出现",
    });
    await trigger.moveTo();
    await assertBodyTextIncludes(["70%"]);
    await assertBodyTextIncludesAny(["5 hours", "5 小时"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/usage/quota/limit") && request.query.type !== "2",
      "Context access 没有读取个人套餐 quota",
    );
  });

  for (const [scenario, planKey, width] of [
    ["personalOnly", PERSONAL_PLAN_KEY, 1200],
    ["teamOnly", TEAM_PLAN_KEY, 1200],
    ["personalOnly", PERSONAL_PLAN_KEY, 390],
    ["teamOnly", TEAM_PLAN_KEY, 390],
  ] as const) {
    it(`CTP-11: ${scenario} ${width}px quota 失败保留套餐入口，重新进入来源后恢复`, async function () {
      this.timeout(120000);
      await prepareScenario(scenario, planKey, "quotaBusinessFailure");
      await openUsageSection();
      await setRendererViewport(width, 900);
      // The subscription query stays successful and a quota business failure must not revoke
      // the entitlement, so the tab does not disappear; detail loading then switches to a
      // transport failure, covering the fatal copy and subsequent recovery.
      await setMockScenario(scenario, "quotaFailure");
      await clickUsageCodingPlanTab(planKey);
      await assertBodyTextIncludesAny([
        "Unable to load usage stats",
        "无法读取用量统计。请稍后重试，或检查网络和供应商配置。",
      ]);
      await assertBodyTextExcludes(["350.7K", "35.1万", "35.1 万", "glm-credit-e2e"]);

      await setMockScenario(scenario, "none");
      await clickVisibleTestIdByDom(testId(TID_SETTINGS_USAGE_TAB, "app"), {
        timeout: 10000,
        timeoutMsg: "致命失败恢复时无法切换到 App Usage",
      });
      await clickUsageCodingPlanTab(planKey);
      await assertBodyTextIncludes([scenario === "teamOnly" ? "90%" : "70%", "glm-credit-e2e"]);
      await assertBodyTextIncludesAny(["350.7K", "35.1万", "35.1 万"]);
    });
  }

  it("QR-E2E-01: 空状态应调用 opportunity 并以强制 status 结果展示机会", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "emptyThenGrant");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await waitForMockRequest(
      (request) => request.path.endsWith("/api/v1/coding-plan/reset/opportunity"),
      "空 reset 状态没有触发 opportunity",
    );
    await waitForResetOpportunityCount(1);

    const resetPaths = (await readMockRequests())
      .map((request) => request.path)
      .filter((path) => path.includes("/api/v1/coding-plan/reset/"));
    const opportunityIndex = resetPaths.findIndex((path) => path.endsWith("/opportunity"));
    expect(opportunityIndex).toBeGreaterThan(0);
    expect(resetPaths.slice(opportunityIndex + 1).some((path) => path.endsWith("/status"))).toBe(
      true,
    );

    // QR-E2E-05: the single-opportunity badge is likewise clickable and opens the reset dialog (a single opportunity shows no count pill; only the interaction is upgraded to a button).
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["可重置额度", "Resettable quota"]);
    await assertBodyTextIncludesAny(["5 小时额度重置", "5-hour quota reset"]);
  });

  it("QR-E2E-02: 已有多类型机会时仍调用 opportunity，Dialog 只展示 status 权威数量", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "existingMultiple");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await waitForMockRequest(
      (request) => request.path.endsWith("/api/v1/coding-plan/reset/opportunity"),
      "已有 reset 机会时没有继续触发 scope opportunity",
    );
    await waitForResetOpportunityCount(3);
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["可重置额度", "Resettable quota"]);
    await assertBodyTextIncludesAny(["5 小时额度重置", "5-hour quota reset"]);
    await assertBodyTextIncludesAny(["周额度重置", "Weekly quota reset"]);
    // Counts are no longer aggregated into the title; FIVE_HOUR holds 2 opportunities, now shown by the row's count pill.
    await assertBodyTextIncludesAny(["2 次", "×2"]);
  });

  it("QR-E2E-09: Composer 应常驻展示首次机会提醒并在 hover 后收起", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "existingMultiple");
    await reloadRendererWithBigModelCodingPlanSelection();

    await waitForContextResetReminder("initial", ["3 次重置额度", "3 reset available"]);
    await assertContextReminderHiddenInSettings("initial");
    const trigger = await $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
    await trigger.moveTo();
    await browser.waitUntil(async () => !(await isContextResetReminderVisible("initial")), {
      timeout: 10000,
      timeoutMsg: "打开 Context 后首次 reset opportunity 提醒仍未收起",
    });
  });

  it("QR-E2E-10: 最早机会进入最后三分钟时应常驻展示临期提醒", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "urgentOpportunity");
    await reloadRendererWithBigModelCodingPlanSelection();

    await waitForContextResetReminder("urgent", ["重置额度过期", "Reset expires in"]);
    await assertContextReminderHiddenInSettings("urgent");
    const alarmAnimation = await browser.execute(() => {
      const icon = document.querySelector<HTMLElement>(
        '[data-context-reset-reminder="urgent"] .animate-zcode-alarm-ring',
      );
      return icon ? window.getComputedStyle(icon).animationName : null;
    });
    expect(alarmAnimation).toBe("zcode-alarm-ring");
  });

  it("QR-E2E-04: Composer Dialog 打开期间应保持 HoverCard 生命周期", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "existingMultiple");
    await selectBigModelCodingPlanRuntime("individual-coding-plan");

    const trigger = await $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
    await trigger.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "Context usage trigger 没有出现",
    });
    await trigger.moveTo();
    await waitForResetOpportunityCount(3, '[data-slot="hover-card-content"]');
    await clickResetOpportunityBadge('[data-slot="hover-card-content"]');

    await browser.waitUntil(
      async () => {
        const state = await readQuotaResetOverlayState();
        return state.dialogVisible && state.hoverCardVisible;
      },
      {
        timeout: 10000,
        timeoutMsg: "重置 Dialog 打开后 Composer HoverCard 被提前卸载",
      },
    );

    await browser.keys("Escape");
    await browser.waitUntil(
      async () => {
        const state = await readQuotaResetOverlayState();
        return !state.dialogVisible && !state.hoverCardVisible;
      },
      {
        timeout: 10000,
        timeoutMsg: "关闭重置 Dialog 后 Composer HoverCard 没有一起收起",
      },
    );
  });

  it("QR-E2E-03: FIVE_HOUR use 必须等待 status used_at 后才完成", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "fiveHourUse");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
    await waitForResetOpportunityCount(2);
    await clickResetOpportunityBadge();

    const resetButton = await findVisibleButtonByAriaLabels(
      ["重置 5 小时额度", "Reset 5-hour quota"],
      true,
      '[role="dialog"]',
    );
    if (!resetButton) throw new Error("没有找到 FIVE_HOUR reset 按钮");
    await resetButton.click();
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/v1/coding-plan/reset/use") &&
        isRecord(request.body) &&
        request.body.reset_type === "FIVE_HOUR",
      "五小时重置没有发送 reset_type=FIVE_HOUR",
    );
    // Dual-JWT contract: Authorization carries the Bearer zcode JWT; X-Bigmodel-Authorization passes the MaaS JWT straight through.
    const useRequest = (await readMockRequests()).find((request) =>
      request.path.endsWith("/api/v1/coding-plan/reset/use"),
    );
    expect(useRequest?.headers.authorization).toBe("Bearer e2e-zcode-jwt");
    expect(useRequest?.headers["x-bigmodel-authorization"]).toBe("e2e-bigmodel-oauth-token");
    // Timing constraint: after the client's use, the status confirmation retry window is only
    // about 2.5 seconds. Every check before confirm must be a single execute round trip —
    // issuing WebDriver commands button by button would trip the client's failure branch on
    // slow machines first, and the success state would never appear after confirm.
    const processingState = await readDialogResetState();
    if (processingState.resetDisabled !== true || processingState.successVisible) {
      throw new Error(
        `status used_at 未确认前没有保持 processing: ${JSON.stringify(processingState)}`,
      );
    }

    await confirmResetUse();
    await browser.waitUntil(async () => (await readDialogResetState()).successVisible, {
      interval: 100,
      timeout: 10000,
      timeoutMsg: "status used_at 更新后没有显示成功状态",
    });
    await waitForMockRequest(
      (request) => request.path.endsWith("/api/v1/coding-plan/reset/history/read"),
      "确认 reset used_at 后没有上报 history/read",
    );
  });

  it("QR-E2E-14: 同类型多张机会核销一张后，弹框不重开即可展示并核销余下机会", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "multiFiveHourUse");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
    await waitForResetOpportunityCount(3);
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["2 次", "×2"]);

    await clickDialogFiveHourReset("没有找到 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 1, {
      timeout: 10000,
      timeoutMsg: "第一次五小时重置没有发送 /use",
    });

    // Regression point: after the success feedback ends, the row stays inside the dialog,
    // showing the real countdown of the remaining 1 opportunity and becoming clickable again;
    // the old implementation showed "expires in 0 minutes 0 seconds" here and silently ignored
    // further clicks, forcing the user to close and reopen the dialog.
    await waitForDialogResetState(
      (state) =>
        state.resetDisabled === false &&
        !state.successVisible &&
        state.weekResetVisible &&
        state.resetRowText !== null &&
        !["2 次", "×2", "0 分 0 秒", "0m 0s"].some((text) => state.resetRowText?.includes(text)),
      "核销一张后余下机会没有在弹框内直接恢复为可核销",
    );

    await clickDialogFiveHourReset("核销一张后没有找到余下机会的 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 2, {
      timeout: 10000,
      timeoutMsg: "余下机会的再次点击没有真实发送 /use",
    });
    const idempotencyKeys = (await readFiveHourUseRequests()).map((request) =>
      isRecord(request.body) ? request.body.idempotency_key : undefined,
    );
    expect(new Set(idempotencyKeys).size).toBe(2);

    // After opportunities are exhausted the five-hour row collapses; the weekly-quota row is unaffected and not wrongly redeemed.
    await waitForDialogResetState(
      (state) => state.resetDisabled === null && !state.successVisible && state.weekResetVisible,
      "五小时机会耗尽后该行没有收起",
    );
    expect(
      (await readMockRequests()).some(
        (request) =>
          request.path.endsWith("/api/v1/coding-plan/reset/use") &&
          isRecord(request.body) &&
          request.body.reset_type === "WEEK",
      ),
    ).toBe(false);
  });

  it("QR-E2E-15: 完成态再次核销时 status 仍是上一张 used_at，读到新 used_at 才确认成功", async function () {
    this.timeout(120000);
    // The mock delays the /use result by 600ms before it becomes visible in /status; within the window /status still returns the previous card's used_at.
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "multiFiveHourUseLagging");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
    await waitForResetOpportunityCount(3);
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["2 次", "×2"]);

    await clickDialogFiveHourReset("没有找到 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 1, {
      timeout: 10000,
      timeoutMsg: "第一次五小时重置没有发送 /use",
    });
    await waitForDialogResetState(
      (state) => state.resetDisabled === false && !state.successVisible && state.weekResetVisible,
      "第一次核销后余下机会没有恢复为可核销",
    );

    await clickDialogFiveHourReset("核销一张后没有找到余下机会的 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 2, {
      timeout: 10000,
      timeoutMsg: "余下机会的再次点击没有真实发送 /use",
    });

    // Regression point: the old implementation treated the previous card's used_at in the
    // lagging snapshot as a second success; after playing the success feedback early, the row
    // went back to "1 remaining, clickable" and only collapsed at the next 60s poll. After the
    // fix it stays processing and only completes once the new used_at is read.
    let revertedToClickable = false;
    await waitForDialogResetState((state) => {
      revertedToClickable ||= state.resetDisabled === false;
      return state.resetDisabled === null && !state.successVisible && state.weekResetVisible;
    }, "完成态再次核销后五小时行没有随机会耗尽收起");
    expect(revertedToClickable).toBe(false);
    expect(await readFiveHourUseRequests()).toHaveLength(2);
  });
});

async function prepareScenario(
  scenario: CodingPlanScenario,
  bigmodelSelectedKey: string,
  faultMode: CodingPlanFaultMode = "none",
  resetScenario: CodingPlanResetScenario = "none",
  locale?: "zh-CN" | "en-US",
) {
  // Why the fix: the same spec switches personal/team plan scenarios consecutively. The
  // file:// origin's entitlement cache must be cleared before the old Electron exits; running
  // browser.execute after exit gets swallowed by an exception, and the previous scenario's Team
  // snapshot would pollute the next scenario.
  await clearUsageEntitlementCache();
  // Bug root cause: editing setting.json directly while the old Electron/host is still alive
  // lets the exit-phase async write-back overwrite the next scenario's fixture with the
  // previous scenario's. Wait for the process to fully exit first, then write the persisted
  // fixture, and finally let reloadSession only create the new app — only then is the scenario
  // boundary deterministic.
  await quitElectronAppGracefully();
  await setMockScenario(scenario, faultMode);
  await setResetMockScenario(resetScenario);
  await writeCredentials({
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": "e2e-bigmodel-oauth-token",
    "oauth:bigmodel:user_info": JSON.stringify({
      displayName: "BigModel E2E",
      id: "bigmodel-e2e-user",
      username: "bigmodel-e2e-user",
    }),
    zcodejwttoken:
      resetScenario === "none" && !faultMode.startsWith("startBalance") ? "" : "e2e-zcode-jwt",
  });
  const connectionSelection = parseBigModelConnectionSelection(bigmodelSelectedKey);
  await writeSettings({
    ...(locale ? { locale, localePreference: locale } : {}),
    providerFamilyConnectionSelections: {
      bigmodel: connectionSelection,
    },
    providerFamilyDomain: "bigmodel",
    providerFamilyDomainMigrated: true,
    // Bug root cause: multiple reloadSession calls in one spec inherit the workspace written
    // back when the previous scenario closed. The Team Plan case's model-resolution seed
    // explicitly writes DEFAULT_WORKSPACE, so the launch entry must also be pinned to the same
    // project workspace and must not occasionally fall into the conversation workspace.
    lastWorkspaceSession: [
      {
        kind: "local",
        workspacePath: DEFAULT_WORKSPACE,
        workspacePurpose: "project",
      },
    ],
    lastActiveTabIndex: 0,
  });
  // Why the fix: in Electron E2E the file:// renderer hitting browser.refresh() directly
  // occasionally lands on chrome-error://chromewebdata, making every subsequent wait 30s slower
  // per case. Scenario switching needs main/host to re-read the on-disk settings, so
  // reloadSession rebuilds the app.
  await browser.reloadSession();
  // Escape only temporarily closes the occupation onboarding; reloading the Renderer covers the Composer again.
  // Reuse the real Skip flow to finish the isolated account's onboarding so the prerequisite state of reload-style cases persists.
  await skipOccupationOnboardingIfPresent();
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await closeTransientOverlays();
  await waitForProviderConfigPolling();
}

function parseBigModelConnectionSelection(selectedKey: string) {
  if (selectedKey === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan)
    return { kind: "start-plan" as const };
  const parts = selectedKey.split(":");
  if (parts[0] !== "team") {
    return { kind: "individual-coding-plan" as const };
  }
  const [, family, productId, organizationId, projectId] = parts;
  if (family !== "bigmodel" || !productId || !organizationId || !projectId) {
    throw new Error(`无效 Team Plan key: ${selectedKey}`);
  }
  return {
    kind: "team-coding-plan" as const,
    productId,
    organizationId,
    projectId,
  };
}

async function waitForBigModelConnectionSelection(
  kind: "individual-coding-plan" | "team-coding-plan",
) {
  await browser.waitUntil(
    async () => (await readSettings()).providerFamilyConnectionSelections?.bigmodel?.kind === kind,
    {
      timeout: 15000,
      timeoutMsg: `BigModel 连接方式没有收敛到 ${kind}`,
    },
  );
  await waitForProviderConfigPolling();
}

async function clearUsageEntitlementCache() {
  // Why the fix: this spec switches personalOnly/teamOnly mocks within the same file:// origin.
  // useUsageEntitlement's short-TTL localStorage cache keeps the previous scenario's no_plan,
  // so the next time the Usage page opens the Coding Plan tab is wrongly judged as absent.
  try {
    await browser.execute(() => {
      const prefix = "zcode:usage-entitlement:";
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith(prefix)) {
          window.localStorage.removeItem(key);
        }
      }
    });
  } catch {
    // Occasionally there is no executable renderer just before or after reloadSession; a failed cache clear must not block scenario rebuilding.
  }
}

async function openModelProviderSettings() {
  await closeTransientOverlays();
  await ensureSettingsPageOpen();
  await clickVisibleTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 10000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
}

async function assertConnectionModeOptionsInclude(
  expectedOptions: Array<{ key: string; labels: string[] }>,
) {
  await openConnectionModeSelect();
  try {
    for (const expectedOption of expectedOptions) {
      const optionTestId = testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, expectedOption.key);
      const option = await $(sel(optionTestId));
      await option.waitForDisplayed({
        timeout: 10000,
        timeoutMsg: `没有找到连接方式选项: ${optionTestId}`,
      });
      const optionText = await option.getText();
      expect(expectedOption.labels.some((label) => optionText.includes(label))).toBe(true);
    }
  } finally {
    await browser.keys("Escape");
  }
}

async function selectConnectionModeOptionByTestId(optionTestId: string, labelForError: string) {
  await openConnectionModeSelect();
  const option = await $(sel(optionTestId));
  await option.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `没有找到连接方式选项: ${labelForError}`,
  });
  await option.click();
}

async function openConnectionModeSelect() {
  await clickVisibleTestIdByDom(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER, {
    timeout: 10000,
    timeoutMsg: "连接方式选择器没有出现",
  });
}

async function openUsageCodingPlanTab(sourceId?: string) {
  await openUsageSection();
  await clickUsageCodingPlanTab(sourceId);
  await assertBodyTextIncludesAny(["剩余额度", "Quota remaining", "Quota Remaining"]);
}

async function openUsageSection() {
  await closeTransientOverlays();
  await ensureSettingsPageOpen();
  await clickVisibleTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "usage"), {
    timeout: 10000,
    timeoutMsg: "设置页没有出现使用统计分区入口",
  });
}

async function ensureSettingsPageOpen() {
  const settingsPage = $(sel(TID_SETTINGS_PAGE));
  if (!(await settingsPage.isDisplayed().catch(() => false))) {
    // Bug root cause: the new settings architecture keeps a hidden copy of the responsive
    // navigation; the old helper's first test-id pick could hit the invisible node and close
    // the settings page, causing later false reports of the Coding Plan tab disappearing.
    await clickVisibleTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 10000,
      timeoutMsg: "没有找到设置入口按钮",
    });
    await settingsPage.waitForDisplayed({ timeout: 10000 });
  }
}

async function openSidebarUsageStats() {
  await closeTransientOverlays();
  await clickVisibleTestIdByDom(TID_LOGIN_TRIGGER, {
    timeout: 10000,
    timeoutMsg: "没有找到头像菜单入口",
  });
  await clickVisibleTestIdByDom(TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON, {
    timeout: 10000,
    timeoutMsg: "没有找到头像菜单里的使用统计入口",
  });
}

async function closeTransientOverlays() {
  await browser.keys("Escape");
  await browser.pause(100);
}

async function clickUsageCodingPlanTab(sourceId?: string) {
  // Why the fix: the usage stats page changed from a single "codingPlan" tab to per-source
  // "codingPlan:<sourceId>"; tests can no longer hardcode the old test id.
  const staticTabId = testId(TID_SETTINGS_USAGE_TAB, "codingPlan");
  const prefix = `${testId(TID_SETTINGS_USAGE_TAB, "codingPlan:")}`;
  const preferredTabId = sourceId ? testId(TID_SETTINGS_USAGE_TAB, `codingPlan:${sourceId}`) : null;
  let selectedTestId = "";
  try {
    await browser.waitUntil(
      async () => {
        selectedTestId = (await browser.execute(
          (legacyTestId, dynamicPrefix, targetTestId) => {
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>("[data-testid]"),
            ).filter((element) => {
              const current = element.dataset.testid ?? "";
              return current === legacyTestId || current.startsWith(dynamicPrefix);
            });
            // Why the fix: when sourceId is passed, what is verified is exactly that plan's
            // identity. The old helper silently clicked the first visible tab when it could not
            // find the target, disguising "the personal plan is missing" as a later Team data
            // assertion failure. With a specified target the hit must be exact.
            const ordered = targetTestId
              ? candidates.filter((element) => element.dataset.testid === targetTestId)
              : candidates;
            const visible = ordered.find((element) => {
              const style = window.getComputedStyle(element);
              return !(
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number(style.opacity) === 0 ||
                element.getClientRects().length === 0 ||
                element.closest('[aria-hidden="true"], [hidden]')
              );
            });
            return visible?.dataset.testid ?? "";
          },
          staticTabId,
          prefix,
          preferredTabId,
        )) as string;
        return Boolean(selectedTestId);
      },
      {
        timeout: 30000,
        timeoutMsg: "设置页没有出现使用统计 Coding Plan tab",
      },
    );
    const tab = await $(sel(selectedTestId));
    await tab.click();
  } catch (error) {
    throw new Error(
      `设置页没有出现或无法激活 Coding Plan tab: ${selectedTestId}\n${await collectCodingPlanUsageDiagnostics()}`,
      { cause: error },
    );
  }
}

async function setRendererViewport(width: number, height: number) {
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  await browser.waitUntil(
    async () => browser.execute((expectedWidth) => window.innerWidth === expectedWidth, width),
    { timeout: 10000, timeoutMsg: `renderer viewport 没有收敛到 ${width}px` },
  );
}

async function setSettingsTheme(theme: "zai-light" | "zai-dark") {
  const changed = await browser.execute((nextTheme) => {
    const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
      .__testActions;
    const setTheme = actions?.setTheme;
    if (typeof setTheme !== "function") return false;
    (setTheme as (value: string) => void)(nextTheme);
    return true;
  }, theme);
  expect(changed).toBe(true);
}

async function clearRendererViewport() {
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function sendRendererEmulationCommand(method: string, params: Record<string, unknown> = {}) {
  const sent = await browser.electron.execute(
    async (electron, command, commandParams) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const devtools = window.webContents.debugger;
      if (!devtools.isAttached()) devtools.attach("1.3");
      await devtools.sendCommand(command, commandParams);
      return true;
    },
    method,
    params,
  );
  expect(sent).toBe(true);
}

async function collectCodingPlanUsageDiagnostics() {
  const providers = (await readModelProviders()).map((provider) => ({
    id: provider.id,
    enabled: provider.enabled,
    hasApiKey: provider.apiKey.trim().length > 0,
    systemDisabledReason: provider.systemDisabledReason ?? null,
  }));
  const requests = (await readMockRequests()).map((request) => ({
    path: request.path,
    query: request.query,
    organization: request.headers["bigmodel-organization"] ?? null,
    project: request.headers["bigmodel-project"] ?? null,
  }));
  return `诊断: ${JSON.stringify(
    {
      bodyText: (await getBodyText()).slice(0, 2000),
      providers,
      requests,
    },
    null,
    2,
  )}`;
}

async function clickVisibleTestIdByDom(
  currentTestId: string,
  { timeout = 10000, timeoutMsg = `页面没有可见的 test id: ${currentTestId}` } = {},
) {
  // Why the fix: the avatar menu content uses forceMount, so hidden menu items also stay in
  // the DOM. We must wait for a genuinely visible menu item before triggering, otherwise a
  // hidden node gets clicked.
  let latestReason = "not-started";
  await browser.waitUntil(
    async () => {
      const result = (await browser.execute((targetTestId) => {
        function isVisible(element: HTMLElement) {
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
          if (element.getClientRects().length === 0) {
            return false;
          }
          return !element.closest('[aria-hidden="true"], [hidden]');
        }

        function dispatchE2EActivation(element: HTMLElement) {
          element.focus();
          const pointerEventCtor = window.PointerEvent ?? MouseEvent;
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            const event =
              type.startsWith("pointer") && pointerEventCtor === window.PointerEvent
                ? new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    pointerType: "mouse",
                    isPrimary: true,
                  })
                : new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                  });
            element.dispatchEvent(event);
          }
        }

        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === targetTestId && isVisible(item),
        );
        if (!element) {
          return { clicked: false, reason: "missing-visible" };
        }
        const disabled =
          (element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement) &&
          element.disabled;
        if (disabled) {
          return { clicked: false, reason: "disabled" };
        }
        dispatchE2EActivation(element);
        return { clicked: true };
      }, currentTestId)) as { clicked: boolean; reason?: string };
      latestReason = result.reason ?? "clicked";
      return result.clicked;
    },
    {
      timeout,
      timeoutMsg: `${timeoutMsg}: ${latestReason}`,
    },
  );
}

async function selectBigModelCodingPlanRuntime(
  planKind: "individual-coding-plan" | "team-coding-plan" = "individual-coding-plan",
) {
  const providerId =
    planKind === "team-coding-plan"
      ? "account:bigmodel-team-coding-plan"
      : "account:bigmodel-individual-coding-plan";
  // Bug root cause: writing only selectedSupplierKey updated the provider navigation resolution
  // state but not the Composer's Effective Model. Context usage judges the plan type by the
  // real Effective Provider, so the test must complete a Provider/Model selection just like the
  // user.
  await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
    includePlainModelFallback: false,
    providerId,
    providerName: "BigModel Coding Plan",
  });
}

async function reloadRendererWithBigModelCodingPlanSelection() {
  // Bug root cause: QR-09/10 verify the persistent reminder at the Renderer's first mount.
  // Selecting via the model menu produces a pointerdown outside the reminder, which per product
  // rules marks the just-appeared reminder as read; before the app exits, the seed is again
  // overwritten by the old Renderer's close write-back. Writing the official selection store
  // directly and reloading only the Renderer uses the real ModelSelection without introducing a
  // test-only runtime entry or an extra Host restart.
  await seedPersistedModelSelection({
    modelId: BIGMODEL_E2E_MODEL,
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    reasoningLevel: "max",
  });
  await browser.execute(() => window.location.reload());
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await waitForProviderConfigPolling();

  // Bug root cause: writing the recent selection directly only covers the draft's persistence
  // entry; if the current ModelSelectionView does not yet contain that Account Provider, the
  // Composer falls back to preferredSelection per the existing contract. Complete one valid
  // selection through the real selection control first, then reload once — only then is what is
  // verified the user's actual selection -> opportunity path, not a test-specific localStorage
  // assumption.
  await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
    includePlainModelFallback: false,
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    providerName: "BigModel Coding Plan",
  });
  await browser.execute(() => window.location.reload());
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await waitForProviderConfigPolling();
}

async function setMockScenario(
  scenario: CodingPlanScenario,
  faultMode: CodingPlanFaultMode = "none",
) {
  const baseUrl = getMockBaseUrl();
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      faultMode,
      scenario,
      providerResponsive: faultMode.startsWith("startBalance"),
    }),
  });
  if (!response.ok) {
    throw new Error(`切换 Coding Plan mock scenario 失败: ${response.status}`);
  }
}

async function setResetMockScenario(resetScenario: CodingPlanResetScenario) {
  const response = await fetch(`${getMockBaseUrl()}/__e2e/coding-plan/reset-scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resetScenario }),
  });
  if (!response.ok) {
    throw new Error(`切换 Coding Plan reset mock scenario 失败: ${response.status}`);
  }
}

async function confirmResetUse() {
  const response = await fetch(`${getMockBaseUrl()}/__e2e/coding-plan/reset-confirm-use`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`确认 Coding Plan reset use 失败: ${response.status}`);
  }
}

async function waitForResetOpportunityCount(count: number, rootSelector?: string) {
  await browser.waitUntil(
    async () => {
      const labels = (await browser.execute((root: string | undefined) => {
        const scope = root ? document.querySelector(root) : document;
        return Array.from(
          scope?.querySelectorAll<HTMLElement>('[data-reset-opportunity="true"]') ?? [],
        )
          .filter((element) => {
            const style = window.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              element.getClientRects().length > 0
            );
          })
          .map((element) => element.innerText.trim());
      }, rootSelector)) as string[];
      return labels.some((label) => label.includes(String(count)));
    },
    {
      timeout: 10000,
      timeoutMsg: `没有展示 ${count} 次 reset opportunity`,
    },
  );
}

async function clickResetOpportunityBadge(rootSelector?: string) {
  const selector = rootSelector
    ? `${rootSelector} [data-reset-opportunity="true"]`
    : '[data-reset-opportunity="true"]';
  for (const badge of await $$(selector)) {
    if (await badge.isDisplayed()) {
      await badge.click();
      return;
    }
  }
  throw new Error("没有找到可点击的 reset opportunity 徽标");
}

async function isContextResetReminderVisible(phase: "initial" | "urgent") {
  return browser.execute((currentPhase) => {
    const element = document.querySelector<HTMLElement>(
      `[data-context-reset-reminder="${currentPhase}"]`,
    );
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }, phase);
}

async function waitForContextResetReminder(phase: "initial" | "urgent", expectedTexts: string[]) {
  try {
    await browser.waitUntil(
      async () => {
        if (!(await isContextResetReminderVisible(phase))) return false;
        const text = (await browser.execute((currentPhase) => {
          return (
            document.querySelector<HTMLElement>(`[data-context-reset-reminder="${currentPhase}"]`)
              ?.innerText ?? ""
          );
        }, phase)) as string;
        return expectedTexts.some((expected) => text.includes(expected));
      },
      {
        timeout: 15000,
        timeoutMsg: `没有展示 ${phase} reset opportunity reminder`,
      },
    );
  } catch (error) {
    // Bug investigation: a missing reminder must not be left as just a waitUntil timeout. The
    // opportunity API, the Context trigger, and the actual DOM all go into the failure evidence
    // so that "no data" can be distinguished from "opportunity exists but the reminder is collapsed".
    const reminderDiagnostics = await browser.execute(
      (contextTriggerTestId) => ({
        bodyText: document.body?.innerText?.slice(-2500) ?? "",
        contextTriggerVisible: Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid="${contextTriggerTestId}"]`),
        ).some((element) => element.getClientRects().length > 0),
        opportunityBadges: Array.from(
          document.querySelectorAll<HTMLElement>('[data-reset-opportunity="true"]'),
        ).map((element) => ({
          text: element.innerText,
          visible: element.getClientRects().length > 0,
        })),
        reminders: Array.from(
          document.querySelectorAll<HTMLElement>("[data-context-reset-reminder]"),
        ).map((element) => ({
          phase: element.dataset.contextResetReminder ?? null,
          text: element.innerText,
          visible: element.getClientRects().length > 0,
        })),
      }),
      TID_CHAT_CONTEXT_USAGE_TRIGGER,
    );
    const resetRequests = (await readMockRequests())
      .filter((request) => request.path.includes("/coding-plan/reset/"))
      .map((request) => ({ method: request.method, path: request.path }));
    throw new Error(
      `没有展示 ${phase} reset opportunity reminder\n诊断: ${JSON.stringify(
        { reminderDiagnostics, resetRequests },
        null,
        2,
      )}`,
      { cause: error },
    );
  }
}

async function readQuotaResetOverlayState() {
  return browser.execute(() => {
    const isVisible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0
      );
    };
    return {
      dialogVisible: isVisible(document.querySelector('[role="dialog"]')),
      hoverCardVisible: isVisible(document.querySelector('[data-slot="hover-card-content"]')),
    };
  });
}

async function findVisibleButtonByAriaLabels(
  labels: string[],
  required = true,
  rootSelector?: string,
) {
  const selector = rootSelector ? `${rootSelector} button` : "button";
  for (const button of await $$(selector)) {
    if (!(await button.isDisplayed())) continue;
    const ariaLabel = await button.getAttribute("aria-label");
    if (ariaLabel && labels.includes(ariaLabel)) return button;
  }
  if (required) throw new Error(`找不到按钮: ${labels.join("/")}`);
  return undefined;
}

/** One execute round trip reads the FIVE_HOUR reset button and success state inside the dialog;
 *  QR-E2E-03's confirm window is only about 2.5 seconds, and per-button isDisplayed/getAttribute
 *  needs multiple WebDriver round trips that would exceed the window. */
async function readFiveHourUseRequests() {
  return (await readMockRequests()).filter(
    (request) =>
      request.path.endsWith("/api/v1/coding-plan/reset/use") &&
      isRecord(request.body) &&
      request.body.reset_type === "FIVE_HOUR",
  );
}

async function clickDialogFiveHourReset(missingMessage: string) {
  const button = await findVisibleButtonByAriaLabels(
    ["重置 5 小时额度", "Reset 5-hour quota"],
    false,
    '[role="dialog"]',
  );
  if (!button) throw new Error(missingMessage);
  await button.click();
}

async function readDialogResetState() {
  return browser.execute(
    (resetLabels: string[], successLabels: string[], weekResetLabels: string[]) => {
      const dialog = document.querySelector('[role="dialog"]');
      const buttons = dialog
        ? Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
        : [];
      const findByLabels = (candidates: string[]) =>
        buttons.find((button) => candidates.includes(button.getAttribute("aria-label") ?? "")) ??
        null;
      const resetButton = findByLabels(resetLabels);
      return {
        resetDisabled: resetButton ? resetButton.disabled : null,
        // The reset button shares a row container with the type name, count pill, and countdown, used to assert the row's displayed content.
        resetRowText: resetButton?.parentElement?.innerText ?? null,
        successVisible: findByLabels(successLabels) !== null,
        weekResetVisible: findByLabels(weekResetLabels) !== null,
      };
    },
    ["重置 5 小时额度", "Reset 5-hour quota"],
    ["重置成功", "Reset successful"],
    ["重置周额度", "Reset weekly quota"],
  );
}

async function waitForDialogResetState(
  predicate: (state: Awaited<ReturnType<typeof readDialogResetState>>) => boolean,
  timeoutMsg: string,
) {
  let lastState: Awaited<ReturnType<typeof readDialogResetState>> | null = null;
  try {
    await browser.waitUntil(
      async () => {
        const state = await readDialogResetState();
        lastState = state;
        return predicate(state);
      },
      { interval: 100, timeout: 10000, timeoutMsg },
    );
  } catch (error) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(lastState)}`, { cause: error });
  }
}

async function waitForMockRequest(
  predicate: (request: MockRequest) => boolean,
  timeoutMsg: string,
) {
  await browser.waitUntil(async () => (await readMockRequests()).some(predicate), {
    timeout: 10000,
    timeoutMsg,
  });
}

async function waitForLatestMockRequest(
  predicate: (request: MockRequest) => boolean,
  timeoutMsg: string,
): Promise<MockRequest> {
  let match: MockRequest | undefined;
  await browser.waitUntil(
    async () => {
      match = (await readMockRequests()).findLast(predicate);
      return Boolean(match);
    },
    { timeout: 10000, timeoutMsg },
  );
  if (!match) {
    throw new Error(timeoutMsg);
  }
  return match;
}

async function clickVisibleButtonByText(labels: string[]): Promise<void> {
  for (const button of await $$("button")) {
    if ((await button.isDisplayed()) && labels.includes((await button.getText()).trim())) {
      await button.click();
      return;
    }
  }
  throw new Error(`找不到可见按钮: ${labels.join("/")}`);
}

function daysBetweenMonitorTimes(startTime: string, endTime: string): number {
  const start = Date.parse(startTime.replace(" ", "T") + "Z");
  const end = Date.parse(endTime.replace(" ", "T") + "Z");
  return Math.floor((end - start) / 86_400_000);
}

function requireQueryValue(request: MockRequest, key: string): string {
  const value = request.query[key];
  if (!value) {
    throw new Error(`mock request 缺少 query: ${key}`);
  }
  return value;
}

function requestRangeDays(request: MockRequest): number | null {
  const startTime = request.query.startTime;
  const endTime = request.query.endTime;
  return startTime && endTime ? daysBetweenMonitorTimes(startTime, endTime) : null;
}

async function readMockRequests(): Promise<MockRequest[]> {
  const response = await fetch(`${getMockBaseUrl()}/__e2e/coding-plan/requests`);
  const payload = (await response.json()) as { requests?: MockRequest[] };
  return payload.requests ?? [];
}

function getMockBaseUrl() {
  const baseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
  if (!baseUrl) {
    throw new Error("ZCODE_E2E_CODING_PLAN_MOCK_URL 未配置");
  }
  return baseUrl;
}

async function writeSettings(patch: Record<string, unknown>) {
  await mkdir(join(E2E_STORAGE_ROOT, "v2"), { recursive: true });
  const current = await readSettings();
  await writeFile(SETTINGS_FILE, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function writeCredentials(patch: Record<string, unknown>) {
  await mkdir(join(E2E_STORAGE_ROOT, "v2"), { recursive: true });
  const current = await readJsonFile(CREDENTIALS_FILE);
  await writeFile(CREDENTIALS_FILE, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function readSettings(): Promise<{
  providerFamilyConnectionSelections?: {
    bigmodel?: ProviderFamilyConnectionSelection;
  };
  [key: string]: unknown;
}> {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertBodyTextIncludes(values: string[]) {
  try {
    await browser.waitUntil(
      async () => {
        const bodyText = await getBodyText();
        return values.every((value) => bodyText.includes(value));
      },
      {
        timeout: 10000,
        timeoutMsg: `页面没有出现全部文本: ${values.join(" / ")}`,
      },
    );
  } catch (error) {
    throw new Error(
      `页面没有出现全部文本: ${values.join(" / ")}\n当前页面文本:\n${(await getBodyText()).slice(0, 2000)}`,
      { cause: error },
    );
  }
}

async function assertBodyTextIncludesAny(values: string[]) {
  try {
    await browser.waitUntil(
      async () => {
        const bodyText = await getBodyText();
        return values.some((value) => bodyText.includes(value));
      },
      {
        timeout: 10000,
        timeoutMsg: `页面没有出现任一文本: ${values.join(" / ")}`,
      },
    );
  } catch (error) {
    throw new Error(
      `页面没有出现任一文本: ${values.join(" / ")}\n当前页面文本:\n${(await getBodyText()).slice(0, 2000)}`,
      { cause: error },
    );
  }
}

async function assertBodyTextExcludes(values: string[]) {
  const bodyText = await getBodyText();
  for (const value of values) {
    expect(bodyText).not.toContain(value);
  }
}

function getBodyText() {
  return browser.execute(() => document.body?.innerText ?? "");
}

interface MockRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  query: Record<string, string>;
}

type ReminderNavigationWindow = Window & {
  __zcodeTabStoreE2E: {
    getState(): {
      activeTabId: string | null;
      openSettingsTab(): void;
      activateTab(id: string): void;
    };
  };
};

async function assertContextReminderHiddenInSettings(phase: "initial" | "urgent") {
  // Switch layers via the real navigation store so the entry-opening pointerdown does not
  // pre-mark the reminder as read and mask the Portal leak.
  const workspaceTabId = await browser.execute(() => {
    const store = (window as unknown as ReminderNavigationWindow).__zcodeTabStoreE2E;
    const id = store.getState().activeTabId;
    store.getState().openSettingsTab();
    return id;
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 10000 });
  await browser.waitUntil(async () => !(await isContextResetReminderVisible(phase)), {
    timeout: 5000,
    timeoutMsg: "Composer 提醒穿透到设置页",
  });
  // Settings page clicks must not consume the background workspace's reminder state.
  await browser.execute(() =>
    document
      .querySelector('[data-testid="settings-page"]')!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  await browser.execute(
    (id) =>
      (window as unknown as ReminderNavigationWindow).__zcodeTabStoreE2E
        .getState()
        .activateTab(id!),
    workspaceTabId,
  );
  await browser.waitUntil(async () => await isContextResetReminderVisible(phase), {
    timeout: 5000,
    timeoutMsg: "设置页点击误将 Composer 提醒标记为已读",
  });
}
