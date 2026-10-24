import { join } from "node:path";
import { getE2EAppDataPaths, waitForDefaultWorkspaceReady } from "../helpers/desktop-app.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../helpers/e2e-electron-reload.js";
import {
  DEFERRED_ROWS_PROJECT_COUNT,
  deferredRowsProjectIndex,
  deferredRowsProjectPath,
  deferredRowsTaskId,
  insertDeferredRowsTasks,
} from "../helpers/project-deferred-rows-fixture.js";
import { ensureLocalProjectRow } from "../helpers/project-sidebar.js";

// specs/project-sidebar-deferred-rows.md (ISSUE-064): in the "By project" view an expanded
// project far below the fold renders a placeholder instead of its task rows until it is reachable.

interface ProjectRowsState {
  placeholder: boolean;
  rows: string[];
}

function readProjectRows(name: string): Promise<ProjectRowsState> {
  return browser.execute((projectName) => {
    const section = document.querySelector(`[data-project-id][data-project-name="${projectName}"]`);
    if (!section) throw new Error(`project section missing: ${projectName}`);
    return {
      placeholder: Boolean(section.querySelector("[data-project-rows-placeholder]")),
      rows: [...section.querySelectorAll('[data-testid^="task-item-"]')].map(
        (row) => row.getAttribute("data-testid") ?? "",
      ),
    };
  }, name);
}

/** Seeded project names in sidebar order (top to bottom). */
function readSeededOrder(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll("[data-project-id][data-project-name^='deferred-']")].map(
      (node) => node.getAttribute("data-project-name") ?? "",
    ),
  );
}

function firstRowId(name: string): string {
  return `task-item-${deferredRowsTaskId(deferredRowsProjectIndex(name), 0)}`;
}

function scrollSidebar(position: "top" | "bottom"): Promise<void> {
  return browser.execute((target) => {
    const viewport = document.querySelector<HTMLElement>("[data-project-rows-viewport]");
    if (!viewport) throw new Error("sidebar scroll viewport missing");
    viewport.scrollTop = target === "top" ? 0 : viewport.scrollHeight;
  }, position);
}

async function switchView(view: "projects" | "timeline"): Promise<void> {
  const item = $(`[data-testid="sidebar-view-${view}"]`);
  // The menu trigger can be mid close-animation from the previous switch; reopen until the item shows.
  await browser.waitUntil(
    async () => {
      if (!(await item.isDisplayed())) await $('[data-testid="sidebar-view-menu"]').click();
      return item.isDisplayed();
    },
    { timeout: 5_000, timeoutMsg: `sidebar view menu did not offer ${view}` },
  );
  await item.click();
  await item.waitForDisplayed({ reverse: true, timeout: 5_000 });
}

describe("project sidebar deferred rows E2E", () => {
  const { homeDir } = getE2EAppDataPaths();
  let order: string[] = [];
  let top = "";
  let bottom = "";

  before(async function () {
    this.timeout(240_000);
    await waitForDefaultWorkspaceReady(45_000);
    for (let index = 0; index < DEFERRED_ROWS_PROJECT_COUNT; index += 1)
      await ensureLocalProjectRow(deferredRowsProjectPath(homeDir, index));
    // Task rows are written while the app is stopped; the next Host start assigns them to the
    // projects created above through the product's own legacy-row reconcile.
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => insertDeferredRowsTasks(homeDir),
    });
    // The restored active workspace is whichever project was opened last, so wait for the seeded tree.
    await browser.waitUntil(
      async () => (await readSeededOrder()).length === DEFERRED_ROWS_PROJECT_COUNT,
      { timeout: 30_000, timeoutMsg: "seeded projects did not render after restart" },
    );
    order = await readSeededOrder();
    top = order[0]!;
    bottom = order.at(-1)!;
    await scrollSidebar("top");
    await $(`[data-testid="${firstRowId(top)}"]`).waitForExist({ timeout: 30_000 });
  });

  afterEach(async function () {
    if (this.currentTest?.state === "failed")
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `deferred-rows-${Date.now()}.png`),
      );
  });

  it("SBD01: projects near the top mount rows; far expanded projects hold a placeholder", async () => {
    await scrollSidebar("top");
    const first = await readProjectRows(top);
    expect(first.placeholder).toBe(false);
    // Comparator order: newest first, one page of five rows.
    const index = deferredRowsProjectIndex(top);
    expect(first.rows).toEqual(
      [0, 1, 2, 3, 4].map((task) => `task-item-${deferredRowsTaskId(index, task)}`),
    );
    expect(await readProjectRows(bottom)).toEqual({ placeholder: true, rows: [] });
  });

  it("SBD02: Tab from a deferred project's header reaches that project's first row", async () => {
    await scrollSidebar("top");
    let target = "";
    for (const name of order)
      if ((await readProjectRows(name)).placeholder) {
        target = name;
        break;
      }
    expect(target).not.toBe("");
    // Focus without scrolling, so only the focus rule (not the viewport rule) can reveal rows.
    await browser.execute((name) => {
      document
        .querySelector<HTMLElement>(
          `[data-project-name="${name}"] [data-testid="virtual-project-row"]`,
        )!
        .focus({ preventScroll: true });
    }, target);
    await browser.waitUntil(async () => !(await readProjectRows(target)).placeholder, {
      timeout: 5_000,
      timeoutMsg: "focus did not mount the deferred project's rows",
    });
    let reached = "";
    for (let step = 0; step < 8 && reached !== firstRowId(target); step += 1) {
      await browser.keys("Tab");
      reached = await browser.execute(
        () =>
          document.activeElement
            ?.closest('[data-testid^="task-item-"]')
            ?.getAttribute("data-testid") ?? "",
      );
    }
    expect(reached).toBe(firstRowId(target));
  });

  it("SBD03: scrolling a far project into view mounts its rows, and they stay mounted", async () => {
    await scrollSidebar("top");
    expect((await readProjectRows(bottom)).placeholder).toBe(true);
    await scrollSidebar("bottom");
    await browser.waitUntil(async () => (await readProjectRows(bottom)).rows.length === 5, {
      timeout: 5_000,
      timeoutMsg: "scrolling did not mount the bottom project's rows",
    });
    await scrollSidebar("top");
    expect((await readProjectRows(bottom)).rows).toHaveLength(5);
  });

  it("SBD04: the active task's row stays mounted off-screen and scrolls into view", async () => {
    await scrollSidebar("bottom");
    // Rows re-render on list refreshes, so every step looks the row up again.
    const row = () => $(`[data-testid="${firstRowId(bottom)}"]`);
    const isSelected = async () =>
      (await row().getAttribute("class"))?.includes("bg-selected") ?? false;
    await row().waitForDisplayed({ timeout: 5_000 });
    await browser.waitUntil(
      async () => {
        try {
          if (!(await isSelected())) await row().click();
          return await isSelected();
        } catch {
          return false;
        }
      },
      { timeout: 15_000, timeoutMsg: "clicked task did not become the active row" },
    );
    // Remount every project node at the top: only reachable projects and the active one mount rows.
    await switchView("timeline");
    await $('[data-testid="project-timeline-tasks"]').waitForExist({ timeout: 5_000 });
    await scrollSidebar("top");
    await switchView("projects");
    await $(`[data-project-name="${bottom}"]`).waitForExist({ timeout: 5_000 });
    await scrollSidebar("top");
    const state = await readProjectRows(bottom);
    expect(state.placeholder).toBe(false);
    expect(state.rows).toContain(firstRowId(bottom));
    // Deferral is still in effect for projects that are neither reachable nor active.
    const deferred: string[] = [];
    for (const name of order) if ((await readProjectRows(name)).placeholder) deferred.push(name);
    expect(deferred.length).toBeGreaterThan(0);
    // The active row is in the DOM, so scrolling to it lands on the highlighted row.
    await row().scrollIntoView({ block: "center" });
    expect(await row().isDisplayed({ withinViewport: true })).toBe(true);
    expect(await isSelected()).toBe(true);
  });
});
