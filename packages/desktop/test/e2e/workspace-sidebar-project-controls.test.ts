import { dirname } from "node:path";
import {
  TID_WORKSPACE_ITEM,
  TID_WORKSPACE_LIST,
  TID_WORKSPACE_PIN_DIVIDER,
  TID_WORKSPACE_TOGGLE_PIN,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  hoverTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "./helpers/desktop-app.js";
import {
  SMALL_AGENT_WARMUP_SCENARIO,
  getPassiveAgentStartupWorkspacePaths,
} from "./helpers/passive-agent-startup-fixture.js";
import { waitForRestoredWorkspaceItems } from "./helpers/workspace-agent-warmup.js";

describe("workspace sidebar project controls E2E", () => {
  after(async () => {
    await clearAppData();
  });

  it("WSPC-PINS-01: pins and unpins projects without mixing them into the manual order", async function () {
    this.timeout(120_000);
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      SMALL_AGENT_WARMUP_SCENARIO.workspaceCount,
    );
    const firstWorkspace = workspacePaths[SMALL_AGENT_WARMUP_SCENARIO.activeWorkspaceIndex];
    const secondWorkspace = workspacePaths.find((path) => path !== firstWorkspace);
    if (!firstWorkspace || !secondWorkspace) throw new Error("pin E2E requires two workspaces");

    await waitForWorkspaceApp(firstWorkspace, 30_000);
    await waitForRestoredWorkspaceItems(workspacePaths, 30_000);
    await openWorkspaceMenu(secondWorkspace);
    await clickTestIdByDom(testId(TID_WORKSPACE_TOGGLE_PIN, secondWorkspace));

    await browser.waitUntil(
      () =>
        browser.execute(
          (params) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
              (candidate) => candidate.dataset.testid === params.rowId,
            );
            if (!row) return false;
            return row.querySelector('[data-workspace-pinned-indicator="true"]') !== null;
          },
          { rowId: testId(TID_WORKSPACE_ITEM, secondWorkspace) },
        ),
      { timeout: 10_000, timeoutMsg: "Pinned project indicator did not appear" },
    );
    await waitForTestIdByDom(TID_WORKSPACE_PIN_DIVIDER);
    const firstRowAfterPin = await browser.execute((listId) => {
      const list = document.querySelector(`[data-testid="${listId}"]`);
      return list?.querySelector<HTMLElement>(`[data-testid^="workspace-item-"]`)?.dataset.testid;
    }, TID_WORKSPACE_LIST);
    expect(firstRowAfterPin).toBe(testId(TID_WORKSPACE_ITEM, secondWorkspace));

    await openWorkspaceMenu(secondWorkspace);
    await clickTestIdByDom(testId(TID_WORKSPACE_TOGGLE_PIN, secondWorkspace));
    await browser.waitUntil(
      () =>
        browser.execute(
          (rowId) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
              (candidate) => candidate.dataset.testid === rowId,
            );
            if (!row) return false;
            return row.querySelector('[data-workspace-pinned-indicator="true"]') === null;
          },
          testId(TID_WORKSPACE_ITEM, secondWorkspace),
        ),
      { timeout: 10_000, timeoutMsg: "Pinned project indicator did not clear" },
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (dividerId) => !document.querySelector(`[data-testid="${dividerId}"]`),
          TID_WORKSPACE_PIN_DIVIDER,
        ),
      { timeout: 10_000, timeoutMsg: "Pin divider remained after unpinning the only project" },
    );
  });

  it("WSPC-DISPLAY-01: customizes the project label and color, then resets both", async function () {
    this.timeout(120_000);
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(dirname(DEFAULT_WORKSPACE), 1);
    const workspacePath = workspacePaths[0];
    if (!workspacePath) throw new Error("customization E2E requires a workspace");

    await waitForWorkspaceApp(workspacePath, 30_000);
    await waitForRestoredWorkspaceItems(workspacePaths, 30_000);
    const rowId = testId(TID_WORKSPACE_ITEM, workspacePath);
    await openWorkspaceMenu(workspacePath);
    await clickTestIdByDom("workspace-customize");
    await waitForTestIdByDom("workspace-customize-dialog");

    await setInputValueByTestIdDom("workspace-customize-display-name", "Sidebar Alias");
    await $('[data-customize-color="blue"]').click();
    await clickTestIdByDom("workspace-customize-save");
    await browser.waitUntil(
      () =>
        browser.execute(
          (params) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
              (candidate) => candidate.dataset.testid === params.rowId,
            );
            const icon = row?.querySelector<HTMLElement>("[data-workspace-color]");
            return (
              row?.textContent?.includes(params.label) && icon?.dataset.workspaceColor === "blue"
            );
          },
          { rowId, label: "Sidebar Alias" },
        ),
      { timeout: 10_000, timeoutMsg: "Customized project label/color did not render" },
    );

    await openWorkspaceMenu(workspacePath);
    await clickTestIdByDom("workspace-customize");
    await waitForTestIdByDom("workspace-customize-dialog");
    await clickTestIdByDom("workspace-customize-reset");
    await browser.waitUntil(
      () =>
        browser.execute(
          (params) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
              (candidate) => candidate.dataset.testid === params.rowId,
            );
            const icon = row?.querySelector<HTMLElement>("[data-workspace-color]");
            return (
              !row?.textContent?.includes("Sidebar Alias") && icon?.dataset.workspaceColor === ""
            );
          },
          { rowId },
        ),
      { timeout: 10_000, timeoutMsg: "Project customization did not reset" },
    );
  });
});

async function openWorkspaceMenu(workspacePath: string): Promise<void> {
  const rowId = testId(TID_WORKSPACE_ITEM, workspacePath);
  await hoverTestIdByWebDriver(rowId);
  await browser.waitUntil(
    () =>
      browser.execute((itemId) => {
        const item = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => candidate.dataset.testid === itemId,
        );
        const moreButton = Array.from(
          item?.closest("li")?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => button.getAttribute("aria-label") === "More");
        if (!moreButton) return false;
        moreButton.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        moreButton.click();
        return true;
      }, rowId),
    { timeout: 10_000, timeoutMsg: `Workspace menu did not open for ${workspacePath}` },
  );
}
