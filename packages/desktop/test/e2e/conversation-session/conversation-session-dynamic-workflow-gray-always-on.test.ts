import { readFile } from "node:fs/promises";
import { clearAppData, waitForTestIdByDom } from "../helpers/desktop-app.js";
import {
  getV4SlashOptionIds,
  prepareV4ConversationE2E,
  waitForV4SlashOption,
} from "../helpers/v4-conversation.js";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_GOAL_OPTION_ID,
  PLUS_WORKFLOW_OPTION_ID,
  SLASH_GOAL_OPTION_ID,
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  openAutomationsPage,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  readDynamicWorkflowGrayMockStatus,
  readPlusMenuAddOptionIds,
  setComposerDraft,
} from "../helpers/dynamic-workflow-gray.js";

// DWG-08 (alwaysOn tier): the server's /client/configs sends down dynamicWorkflow.mode = "alwaysOn",
// so all three entries are present at once — the "Workflow" item in the `+` menu, workflow in the `/` panel, and the "Workflow" tab on the automations page.
// Shares the same set of actions as the disabled tier, only with reversed assertions; the server shape picks the tier by this file's name.
// Contract: docs/dynamic-workflow/launch.md "Gray release: the `dynamicWorkflow` feature key".
// E2E_DWF_GRAY: read-only entries, no prompt sent; the empty provider fixture is an intentional contract.
describe("动态工作流灰度命中（alwaysOn）", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  afterEach(async () => {
    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    if (!capturePath) throw new Error("Missing provider capture evidence");
    expect(JSON.parse(await readFile(capturePath, "utf8")).records).toEqual([]);
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWG-08 命中时 + 菜单、/ 面板与自动化页都提供工作流入口", async function () {
    this.timeout(180000);

    // 0) Confirm this round uses the same case-local gateway and that it sends down alwaysOn.
    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("alwaysOn");
    expect(status.mode).toBe("alwaysOn");
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 1) `/` panel: workflow is present and, per product requirements, immediately follows goal (the order of APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES).
    //    Use goal as the catalog barrier first, then wait for workflow to arrive in the same panel without rewriting the draft again.
    await openSlashPanelWithCatalogReady();
    await waitForV4SlashOption(SLASH_WORKFLOW_OPTION_ID, 60000);
    const slashIds = await getV4SlashOptionIds();
    expect(slashIds.indexOf(SLASH_WORKFLOW_OPTION_ID)).toBe(
      slashIds.indexOf(SLASH_GOAL_OPTION_ID) + 1,
    );
    await closeSlashPanel();

    // 2) `+` menu: Workflow is present and ordered after Goal.
    await setComposerDraft("");
    await openPlusMenu();
    await $(`[data-trigger="+"] [data-option-id="${PLUS_WORKFLOW_OPTION_ID}"]`).waitForDisplayed();
    const addIds = await readPlusMenuAddOptionIds();
    expect(addIds.indexOf(PLUS_WORKFLOW_OPTION_ID)).toBe(addIds.indexOf(PLUS_GOAL_OPTION_ID) + 1);
    await closePlusMenu();

    // 3) Automations page: the title itself switches; both the "Automation / Workflow" tabs are present.
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30000,
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(automationsPageTabTestId("automation"), {
      timeout: 30000,
      timeoutMsg: "自动化页标题没有「自动化」切换",
    });
  });
});
