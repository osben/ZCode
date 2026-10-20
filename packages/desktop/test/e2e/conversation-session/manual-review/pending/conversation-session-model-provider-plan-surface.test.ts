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
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_BIGMODEL_START_PROVIDER_ID,
  E2E_PLAN_DEFAULT_MODEL,
  E2E_PLAN_NON_DEFAULT_MODEL,
  restartIntoWorkspace,
  restartIntoWorkspacePreservingProfile,
  seedBigModelOAuthCredential,
  seedBigModelConnectionSelection,
  seedBigModelStartPlanCredential,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "../../../helpers/model-provider-restart.js";
import { prepareConversationE2E, startNewTask } from "../../../helpers/conversation-session.js";
import { sel } from "../../../helpers/selectors.js";

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

    await prepareConversationE2E({ skipProvider: true });
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
    await restartIntoWorkspace();
    // First run the formal upstream provider initialization so the Automation form's local Host
    // already has an executable model; then switch to the two case-local plan providers from the real dropdown menu.
    await prepareConversationE2E();

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
    await startNewTask();
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
    await restartIntoWorkspacePreservingProfile();
    await prepareConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);

    // While the catalog is unavailable, only the current selection is kept; the draft is not silently changed to upstream. After the
    // catalog recovers, restart once more and verify the same selection can still serve as the initial configuration for the next send.
    await setCatalogMode("full");
    await restartIntoWorkspacePreservingProfile();
    await prepareConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);
  });

  it("F-PLAN-006: 服务端只返回部分目录时不覆盖已有模型事实", async function () {
    this.timeout(220000);
    await prepareBigModelCatalogWorkspace(E2E_PLAN_NON_DEFAULT_MODEL);
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    await setCatalogMode("partial");
    await restartIntoWorkspacePreservingProfile();
    await prepareConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
  });
});

async function prepareBigModelCatalogWorkspace(model: string): Promise<void> {
  await prepareConversationE2E({ skipProvider: true });
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
  await seedPersistedModelSelection({
    modelId: model,
    providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    reasoningLevel: "max",
  });
  await setCatalogMode("full");
  await restartIntoWorkspace();
  await prepareConversationE2E({ skipProvider: true });
  await selectAutomationModel(encodeCustomModelValue(E2E_BIGMODEL_PLAN_PROVIDER_ID, model));
  // The selection action itself only updates draft state; to prepare a persisted user preference for "restore the most recent model
  // after restart", wait for the catalog state switch and let the real app startup logic read and assert it, instead of directly mutating
  // the post-restart runtime state from the test.
  await seedPersistedModelSelection({
    modelId: model,
    providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    reasoningLevel: "max",
  });
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
  await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
    timeout: 30000,
    timeoutMsg: `Automation ${title} 保存后没有回到列表`,
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
  await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER, {
    timeout: 15000,
    timeoutMsg: "Automation 表单没有模型选择器",
  });
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, modelValue);
  const groupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${decoded.providerId}`,
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemId, groupId) =>
          Boolean(
            document.querySelector(`[data-testid="${itemId}"]`) ||
            document.querySelector(`[data-testid="${groupId}"]`),
          ),
        itemTestId,
        groupTestId,
      ),
    { timeout: 30000, timeoutMsg: `Automation 模型菜单没有出现 ${modelValue}` },
  );
  if (!(await $(sel(itemTestId)).isExisting())) {
    await $(sel(groupTestId)).click();
    await $(sel(itemTestId)).waitForDisplayed({ timeout: 15000 });
  }
  await $(sel(itemTestId)).click();
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value")) ===
      modelValue,
    { timeout: 15000, timeoutMsg: `Automation 模型没有切换到 ${modelValue}` },
  );
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
  await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
    timeout: 30000,
    timeoutMsg: "Automation 编辑后没有回到列表",
  });
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
