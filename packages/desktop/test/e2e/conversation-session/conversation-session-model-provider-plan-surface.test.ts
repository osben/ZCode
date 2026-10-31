import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CREATE_MENU,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_OPEN,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_START_PLAN_RECOMMENDATION_DIALOG,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_BIGMODEL_START_PROVIDER_ID,
  E2E_PLAN_DEFAULT_MODEL,
  E2E_PLAN_NON_DEFAULT_MODEL,
  seedBigModelOAuthCredential,
  seedBigModelConnectionSelection,
  seedBigModelStartPlanCredential,
  seedReplayProvider,
  waitForSelectedModel,
} from "../helpers/model-provider-restart.js";
import {
  prepareV4ConversationE2E,
  startNewV4Draft,
  setV4ComposerText,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { sel } from "../helpers/selectors.js";

const PLAN_PROVIDER_ID = E2E_BIGMODEL_PLAN_PROVIDER_ID;
const PLAN_MODEL = "GLM-5.2";
const START_PROVIDER_ID = E2E_BIGMODEL_START_PROVIDER_ID;
const START_MODEL = "GLM-5.2";
const PLAN_MODEL_VALUE = encodeCustomModelValue(PLAN_PROVIDER_ID, PLAN_MODEL);
const START_MODEL_VALUE = encodeCustomModelValue(START_PROVIDER_ID, START_MODEL);
/**
 * An automation task's model selection is a task-local record; it must not be rewritten because the chat default plan changes.
 * This uses the server-delivered BigModel Coding/Start Plan providers and reconciles the full providerId/modelId
 * from the read-only task index; runtime requests are covered by the existing Cron E2E.
 */
describe("Automation 在 Start/Coding Plan 间保存模型身份 E2E", () => {
  afterEach(async () => {
    await setCatalogMode("full").catch(() => undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("F-AUTOMATION-004/F-AUTOMATION-005/F-AUTOMATION-006/F-PLAN-004/F-PLAN-008: 两种计划分别保存，任务记录不跟随默认值漂移", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await seedBigModelOAuthCredential();
    await seedBigModelStartPlanCredential();
    await seedBigModelConnectionSelection({
      kind: "team-coding-plan",
      productId: "product-team-a",
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });
    await seedReplayProvider({
      id: PLAN_PROVIDER_ID,
      models: [PLAN_MODEL],
      name: "BigModel Coding Plan E2E",
    });
    await seedReplayProvider({
      id: START_PROVIDER_ID,
      models: [START_MODEL],
      name: "BigModel Start Plan E2E",
    });
    await restartCatalogWorkspace();
    // First run the formal upstream provider initialization so the Automation form's local Host
    // already has an executable model; then switch to the two case-local plan providers from the real dropdown menu.
    await prepareV4ConversationE2E();

    const codingTitle = `E2E_AUTOMATION_CODING_PLAN_${Date.now()}`;
    await createAutomation(codingTitle, "固定 Coding Plan 模型", PLAN_MODEL_VALUE);
    const codingRecord = await waitForAutomationModel(codingTitle);
    expect(codingRecord).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });
    // Re-read the persisted value after editing a model-unrelated prompt, covering the path of "saving other fields does
    // not clear the model identity"; edit the first card first, so that after the second card is created the list ordering
    // does not land the user's click on a different task.
    await editAutomationPrompt(codingTitle, "只修改 prompt，不修改模型");
    expect(await readAutomationModel(codingTitle)).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });

    // Both plan providers are real model menu items; switch directly in the Automation form here,
    // verifying that the task saves the full providerId instead of rewriting the same-named GLM-5.2 per the current chat connection.
    // The Family connection selection and Automation's explicit model selection are two orthogonal facts; this case only verifies
    // that Automation saves the full Provider/Model identity, avoiding coupling product state into an undiagnosable failure.
    const startTitle = `E2E_AUTOMATION_START_PLAN_${Date.now()}`;
    await createAutomation(startTitle, "固定 Start Plan 模型", START_MODEL_VALUE);
    const startRecord = await waitForAutomationModel(startTitle);
    expect(startRecord).toEqual({
      providerId: START_PROVIDER_ID,
      modelId: START_MODEL,
    });

    // Creating the second task does not rewrite the first; this is the key assertion of "same-named models distinguished by full plan identity".
    expect(await readAutomationModel(codingTitle)).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });

    // When the same user switches connections in a chat draft, the menu must retain the full provider identity and not deduplicate
    // by model name alone; Automation's two saved values must also remain unchanged.
    await startNewV4Draft();
    await selectAutomationModel(START_MODEL_VALUE);
    expect(
      await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value"),
    ).toBe(START_MODEL_VALUE);
    await selectAutomationModel(PLAN_MODEL_VALUE);
    expect(
      await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value"),
    ).toBe(PLAN_MODEL_VALUE);
    // After the current connection switches back to the Coding Plan, the previously saved Start Plan task keeps its original identity;
    // this is also the minimal observable boundary of "no silent rebinding to another plan" when a plan expires while a task is waiting.
    expect(await readAutomationModel(startTitle)).toEqual({
      providerId: START_PROVIDER_ID,
      modelId: START_MODEL,
    });
  });

  it("F-PLAN-005: 套餐目录暂时不可用时保留当前选择，恢复后仍可继续使用", async function () {
    this.timeout(220000);
    await prepareBigModelCatalogWorkspace(E2E_PLAN_DEFAULT_MODEL);
    await setCatalogMode("unavailable");
    await restartCatalogWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);

    // While the catalog is unavailable, only the current selection is kept; the draft is not silently changed to upstream. After the
    // catalog recovers, restart once more and verify the same selection can still serve as the initial configuration for the next send.
    await setCatalogMode("full");
    await restartCatalogWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);
  });

  it("F-PLAN-006: 服务端只返回部分目录时不覆盖已有模型事实", async function () {
    this.timeout(220000);
    await prepareBigModelCatalogWorkspace(E2E_PLAN_NON_DEFAULT_MODEL);
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    await setCatalogMode("partial");
    await restartCatalogWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
  });
});

async function prepareBigModelCatalogWorkspace(model: string): Promise<void> {
  await prepareV4ConversationE2E({ skipProvider: true });
  // Catalog cold-recovery verifies project preference; the previous case ended on a global draft, so scope first via the real project entry.
  await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
  await seedBigModelOAuthCredential();
  await seedBigModelConnectionSelection({
    kind: "team-coding-plan",
    productId: "product-team-a",
    organizationId: "org-team-a",
    projectId: "proj-team-a",
  });
  await seedReplayProvider({
    id: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    models: [PLAN_MODEL, E2E_PLAN_NON_DEFAULT_MODEL],
    name: "BigModel Coding Plan E2E",
  });

  await setCatalogMode("full");
  await restartCatalogWorkspace();
  await prepareV4ConversationE2E({ skipProvider: true });
  await selectAutomationModel(encodeCustomModelValue(E2E_BIGMODEL_PLAN_PROVIDER_ID, model));
  // The current contract persists only project drafts with body text; the old workspace Recent key is no
  // longer authoritative for this entry. Write body text through the real Composer, then read-only verify
  // the draft is persisted — cold start must not write any model state back.
  const text = "E2E_PLAN_CATALOG_DRAFT";
  await setV4ComposerText(text);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expectedText, providerId, modelId) => {
          return Object.entries(localStorage).some(([key, raw]) => {
            if (!key.startsWith("zcode-v4-composer-project-drafts:v1:")) return false;
            const value = JSON.parse(raw) as {
              scopes?: Record<
                string,
                {
                  text?: string;
                  modelSelection?: { providerId?: string; modelId?: string };
                }
              >;
            };
            return Object.values(value.scopes ?? {}).some(
              (draft) =>
                draft.text === expectedText &&
                draft.modelSelection?.providerId === providerId &&
                draft.modelSelection.modelId === modelId,
            );
          });
        },
        text,
        E2E_BIGMODEL_PLAN_PROVIDER_ID,
        model,
      ),
    {
      timeout: 15000,
      timeoutMsg: "项目草稿的正文和模型未持久化",
    },
  );
}

async function restartCatalogWorkspace(): Promise<void> {
  // The default UI after startup is the global draft; catalog recovery overrides the chosen project's preference, without relying on the old active-tab auto-restore.
  await reloadElectronSessionPreservingBrowserProfile(browser);
  await skipOccupationOnboardingIfPresent();
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft" || Boolean(snapshot.sessionId),
    "目录冷启动后主 pane 未就绪",
  );
  await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
}

async function setCatalogMode(mode: "full" | "partial" | "unavailable"): Promise<void> {
  const baseUrl = process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL?.trim();
  if (!baseUrl) throw new Error("Coding Plan mock URL 未配置，无法切换模型目录状态");
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/catalog-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`模型目录状态切换失败：${response.status}`);
}

async function createAutomation(title: string, prompt: string, modelValue: string): Promise<void> {
  await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeout: 15000 });
  await clickTestIdByWebDriver(TID_AUTOMATION_CREATE_MENU, { timeout: 15000 });
  await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, { timeout: 15000 });
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, title);
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, prompt);
  await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
    timeout: 15000,
  });
  await selectAutomationModel(modelValue);
  await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, { timeout: 15000 });
  await finishAutomationSave();
}

async function finishAutomationSave(): Promise<void> {
  // Saving a Coding Plan triggers a trial-plan recommendation; go through the real "no thanks" action so the original identity is verified as persisted.
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_AUTOMATIONS_LIST)).isExisting()) ||
      (await $(sel(TID_START_PLAN_RECOMMENDATION_DIALOG)).isExisting()),
    { timeout: 30000, timeoutMsg: "Automation 保存既未返回列表，也未出现套餐推荐" },
  );
  const recommendation = $(sel(TID_START_PLAN_RECOMMENDATION_DIALOG));
  if (await recommendation.isExisting()) {
    await recommendation.$("button*=不了").click();
  }
  await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
    timeout: 30000,
    timeoutMsg: "Automation 保存后没有回到列表",
  });
}

async function selectAutomationModel(modelValue: string): Promise<void> {
  const decoded = decodeModelValue(modelValue);
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
  // The current model does not appear again among the menu items; when the Automation create form inherits the chat default model,
  // already matching the target is a valid user-facing result, and "the current item is not in the menu" must not be misjudged as failure.
  if ((await trigger.getAttribute("data-model-current-value")) === modelValue) {
    return;
  }
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER, {
      timeout: 15000,
      timeoutMsg: "Automation 表单没有模型选择器",
    });
  }
  // The composer merged control first shows the current provider's models; open the provider layer to switch to the other plan.
  const providerTrigger = $('[data-testid="composer-provider-trigger"]');
  if (
    (await providerTrigger.isExisting()) &&
    (await providerTrigger.getAttribute("aria-expanded")) !== "true"
  ) {
    await providerTrigger.click();
  }
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, modelValue);
  // Automation uses Registry grouping; the Composer's team grouping also carries account scope.
  // Both entries only locate the same Provider, and the final check still validates the full model value strictly.
  const groupTestIds = [
    testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${decoded.providerId}`),
  ];
  if (decoded.providerId === PLAN_PROVIDER_ID) {
    groupTestIds.push(
      testId(
        TID_CHAT_MODEL_SELECT_GROUP,
        JSON.stringify([
          "bigmodel",
          "team-coding-plan",
          "product-team-a",
          "org-team-a",
          "proj-team-a",
        ]),
      ),
    );
  }
  let visibleGroup: string | undefined;
  try {
    await browser.waitUntil(
      async () => {
        if ((await trigger.getAttribute("data-model-current-value")) === modelValue) return true;
        const visibleIds = await browser.execute(
          (itemId, groupIds) =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
              .filter(
                (element) =>
                  element.getClientRects().length > 0 &&
                  (element.dataset.testid === itemId ||
                    groupIds.includes(element.dataset.testid ?? "")),
              )
              .map((element) => element.dataset.testid),
          itemTestId,
          groupTestIds,
        );
        visibleGroup = groupTestIds.find((id) => visibleIds.includes(id));
        return visibleIds.length > 0;
      },
      { timeout: 30000, timeoutMsg: `模型菜单没有出现 ${modelValue}` },
    );
  } catch (error) {
    const menu = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-"]'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          id: element.dataset.testid,
          text: element.innerText,
          value: element.getAttribute("data-model-current-value"),
        })),
    );
    throw new Error(`模型菜单没有出现 ${modelValue}; menu=${JSON.stringify(menu)}`, {
      cause: error,
    });
  }
  // Hydration may finish after the menu opens; when the current item was dropped from the candidates, do not select again.
  if ((await trigger.getAttribute("data-model-current-value")) === modelValue) {
    await browser.keys("Escape");
    return;
  }
  if (!(await $(sel(itemTestId)).isDisplayed()) && visibleGroup) {
    await clickTestIdByDom(visibleGroup);
    await $(sel(itemTestId)).waitForDisplayed({ timeout: 15000 });
  }
  await $(sel(itemTestId)).click();
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value")) ===
      modelValue,
    { timeout: 15000, timeoutMsg: `Automation 模型没有切换到 ${modelValue}` },
  );
  // After selecting a model, the Composer keeps the popover open to continue picking a tier; explicitly end this interaction before the next independent selection.
  await browser.keys("Escape");
  await browser.waitUntil(async () => (await trigger.getAttribute("aria-expanded")) !== "true", {
    timeout: 15000,
    timeoutMsg: "模型选择结束后弹层未关闭",
  });
}

function decodeModelValue(value: string): { providerId: string } {
  const encoded = value.slice("custom:".length);
  const separator = encoded.indexOf(":");
  return { providerId: decodeURIComponent(separator < 0 ? encoded : encoded.slice(0, separator)) };
}

async function editAutomationPrompt(title: string, prompt: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (cardTestId, expectedTitle) => {
          const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) =>
              element.dataset.testid === cardTestId && element.textContent?.includes(expectedTitle),
          );
          if (!card) return false;
          card.click();
          return true;
        },
        TID_AUTOMATION_CARD,
        title,
      ),
    { timeout: 30000, timeoutMsg: `没有打开 Automation 详情：${title}` },
  );
  await waitForTestIdByDom(TID_AUTOMATION_FORM_PROMPT, {
    timeout: 15000,
    timeoutMsg: "Automation 详情没有 prompt 输入框",
  });
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, prompt);
  await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, { timeout: 15000 });
  await finishAutomationSave();
}

async function waitForAutomationModel(title: string) {
  await browser.waitUntil(async () => (await readAutomationModel(title)) !== null, {
    timeout: 15000,
    timeoutMsg: `没有在任务索引中找到 ${title} 的模型配置`,
  });
  const model = await readAutomationModel(title);
  if (!model) throw new Error(`任务索引中的模型配置为空：${title}`);
  return model;
}

async function readAutomationModel(title: string) {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT model_selection FROM automations WHERE title = ?")
      .get(title) as { model_selection: string | null } | undefined;
    if (!row?.model_selection) return null;
    const selection = JSON.parse(row.model_selection) as {
      modelId?: string;
      providerId?: string;
    };
    return selection.providerId && selection.modelId
      ? { modelId: selection.modelId, providerId: selection.providerId }
      : null;
  } finally {
    database.close();
  }
}
