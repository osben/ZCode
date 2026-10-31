import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

const PROJECT = '[data-project-name="E2E_MISSING_PRIMARY"]';
const SINGLE_PROJECT = '[data-project-name="E2E_SINGLE_PRIMARY"]';
const HISTORY_ID = "sess_e2e_missing_primary_history";
const HISTORY_BODY = "E2E_MISSING_PRIMARY_HISTORY_BODY";
const REASON = "This project's main folder has been deleted or moved";
const REASON_ZH = "该项目主文件夹已被删除或移动";
type TestWindow = Window & {
  __testActions?: {
    setLocale(locale: "en-US" | "uk-UA" | "zh-CN"): void;
    setTheme(theme: string): void;
  };
  __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null } };
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(path: string): {
        activeTaskId: string | null;
        draftProjectId?: string | null;
        draftFocusVersion: number;
      };
    };
  };
};

describe("project primary folder unavailable", () => {
  it("VP-ROOT-01: history stays expandable after the primary folder is moved; new session and file view are disabled; re-enabled after restore", async function () {
    this.timeout(150_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await browser.execute(() => (window as TestWindow).__testActions!.setLocale("en-US"));
    const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "missing-primary");
    const primary = join(root, "primary");
    const extra = join(root, "extra");
    const moved = join(root, "moved");
    const singlePrimary = join(root, "single-primary");
    const singleMoved = join(root, "single-moved");
    await Promise.all([mkdir(primary, { recursive: true }), mkdir(extra, { recursive: true })]);
    await mkdir(singlePrimary, { recursive: true });
    await openEditor("E2E_MISSING_PRIMARY");
    await chooseRoot(primary);
    await chooseRoot(extra);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    let project = $(PROJECT);
    await project.waitForDisplayed();
    let toggle = project.$('[data-testid="virtual-project-toggle"]');
    expect(await toggle.isEnabled()).toBe(true);
    expect(await project.$('[data-testid="virtual-project-files"]').isEnabled()).toBe(true);
    await openEditor("E2E_SINGLE_PRIMARY");
    await chooseRoot(singlePrimary);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    let single = $(SINGLE_PROJECT);
    await single.waitForDisplayed();
    expect(await single.$('[data-testid="virtual-project-files"]').isEnabled()).toBe(true);
    // Return to the primary project under test before the cold-start history seeding; the empty draft of the second control project must not decide the restore target.
    await project.$('[data-testid="virtual-project-create-task"]').click();
    await waitForWorkspaceApp(primary, 30_000);
    // After PCD01 creation the project is auto-selected and its folder prepared; the zero-root control must be a persistent project that was never entered.
    // Write history after the Host exits and cold-start once both databases are ready; do not write the running index and pretend the snapshot has refreshed.
    await restartIntoWorkspacePreservingProfile(primary, {
      afterElectronProcessExit: async () => {
        seedHistory(primary);
        const db = new DatabaseSync(
          join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
        );
        try {
          db.prepare(
            "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES('e2e-empty-primary','local','E2E_EMPTY_PRIMARY',20,1,1)",
          ).run();
        } finally {
          db.close();
        }
      },
    });
    // WebDriver element references are bound to the old session; after the full restart they must be re-acquired from the new renderer.
    project = $(PROJECT);
    single = $(SINGLE_PROJECT);
    toggle = project.$('[data-testid="virtual-project-toggle"]');
    const empty = $('[data-project-name="E2E_EMPTY_PRIMARY"]');
    await empty.waitForDisplayed();
    const readActive = () =>
      browser.execute(
        () => (window as TestWindow).__zcodeTabStoreE2E!.getState().activeWorkspacePath,
      );
    if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    const activeBefore = await readActive();
    try {
      // Trigger window focus after a real filesystem change; do not inject availability or replace project service results.
      await rename(primary, moved);
      await rename(singlePrimary, singleMoved);
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () => (await project.getAttribute("data-primary-root-status")) === "missing",
        {
          timeout: 15_000,
          timeoutMsg: "folder status did not update after the primary folder was moved",
        },
      );
      await project.moveTo();
      const create = project.$('[data-testid="virtual-project-create-task"]');
      expect(await create.isEnabled()).toBe(false);
      const files = project.$('[data-testid="virtual-project-files"]');
      const singleFiles = single.$('[data-testid="virtual-project-files"]');
      expect(await files.isEnabled()).toBe(false);
      expect(await singleFiles.isEnabled()).toBe(false);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await toggle.isEnabled()).toBe(true);
      expect(await toggle.getAttribute("aria-disabled")).toBe("false");
      expect(await empty.$('[data-testid="virtual-project-toggle"]').isEnabled()).toBe(true);
      expect(await empty.$('[data-testid="virtual-project-create-task"]').isEnabled()).toBe(true);
      expect(await empty.$('[data-testid="virtual-project-files"]').isEnabled()).toBe(false);
      for (const theme of ["zai-dark", "zai-light"]) {
        await browser.execute(
          (value) => (window as TestWindow).__testActions!.setTheme(value),
          theme,
        );
        await leaveTooltip();
        await toggle.parentElement().moveTo();
        await expectNoReason();
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-${theme}.png`),
        );
        await leaveTooltip();
        await create.parentElement().moveTo({ xOffset: -2 });
        await create.parentElement().moveTo({ xOffset: 2 });
        await waitForReason();
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-create-${theme}.png`),
        );
        for (const [name, button] of [
          ["multi", files],
          ["single", singleFiles],
        ] as const) {
          await leaveTooltip();
          await button.parentElement().moveTo({ xOffset: -2 });
          await button.parentElement().moveTo({ xOffset: 2 });
          await waitForReason();
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-files-${name}-${theme}.png`),
          );
          await browser.execute(
            (selector) => {
              document
                .querySelector<HTMLButtonElement>(
                  `${selector} [data-testid="virtual-project-files"]`,
                )!
                .click();
            },
            name === "multi" ? PROJECT : SINGLE_PROJECT,
          );
          expect(await $('[data-testid="virtual-project-files-0"]').isExisting()).toBe(false);
          expect(await project.isDisplayed()).toBe(true);
          expect(await readActive()).toBe(activeBefore);
        }
      }
      // Directory invalidity blocks the new-task and file entries; the title still opens the real history through the original collapsed state.
      await browser.execute((selector) => {
        document
          .querySelector<HTMLButtonElement>(
            `${selector} [data-testid="virtual-project-create-task"]`,
          )!
          .click();
      }, PROJECT);
      expect(await readActive()).toBe(activeBefore);
      await toggle.click();
      const history = project.$(`[data-testid="task-item-${HISTORY_ID}"]`);
      await history.waitForDisplayed();
      await toggle.click();
      await history.waitForDisplayed({ reverse: true });
      await browser.execute((selector) => {
        document
          .querySelector<HTMLElement>(`${selector} [data-testid="virtual-project-toggle"]`)!
          .focus();
      }, PROJECT);
      await browser.keys("Enter");
      await history.waitForDisplayed();
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await history.click();
      await $(`//*[normalize-space(.)="${HISTORY_BODY}" and not(*)]`).waitForDisplayed({
        timeout: 30_000,
      });
      expect(await create.isEnabled()).toBe(false);
      await expect(stat(primary)).rejects.toMatchObject({ code: "ENOENT" });
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "missing-primary-history.png"),
      );
      // The old E2E only verified that the project row was disabled; the top button and native menu still request creation, so visible failure feedback must be asserted independently.
      const beforeNewTask = await readTaskState(primary);
      for (const locale of ["zh-CN", "en-US"] as const) {
        await browser.execute(
          (value) => (window as TestWindow).__testActions!.setLocale(value),
          locale,
        );
        const reason = locale === "zh-CN" ? REASON_ZH : REASON;
        for (const theme of ["zai-dark", "zai-light"]) {
          await browser.execute(
            (value) => (window as TestWindow).__testActions!.setTheme(value),
            theme,
          );
          for (const action of ["button", "shortcut"] as const) {
            await waitForNewTaskToastToClose();
            if (action === "button") await $('[data-testid="task-new-button"]').click();
            else await invokeNewTaskShortcut();
            await browser.waitUntil(
              async () => (await $("#zcode-toast-host").getText()).includes(reason),
              {
                timeout: 5_000,
                timeoutMsg: `VP-ROOT-03 ${locale}/${theme}/${action} 未显示目录失效提示`,
              },
            );
            expect(await readTaskState(primary)).toEqual(beforeNewTask);
            await expect(stat(primary)).rejects.toMatchObject({ code: "ENOENT" });
            await browser.saveScreenshot(
              join(
                process.env.ZCODE_E2E_ARTIFACT_DIR!,
                `missing-primary-new-task-${locale}-${theme}-${action}.png`,
              ),
            );
          }
        }
      }
      await waitForNewTaskToastToClose();
      // Restore the baseline locale this case's English assertions depend on (REASON, toggle labels).
      await browser.execute(() => (window as TestWindow).__testActions!.setLocale("en-US"));
      await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      const contextCreate = $('[data-testid="virtual-project-context-create-task"]');
      await contextCreate.waitForDisplayed();
      expect(await contextCreate.getAttribute("aria-disabled")).toBe("true");
      for (const index of [0, 1]) {
        expect(
          await $(`[data-testid="virtual-project-context-files-${index}"]`).getAttribute(
            "aria-disabled",
          ),
        ).toBe("true");
      }
      await browser.keys("Escape");
      await single.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      await $('[data-testid="virtual-project-context-files-0"]').waitForDisplayed();
      expect(
        await $('[data-testid="virtual-project-context-files-0"]').getAttribute("aria-disabled"),
      ).toBe("true");
      await browser.keys("Escape");
      await project.moveTo();
      await project.$('[data-testid="virtual-project-menu"]').click();
      await $('[data-testid="virtual-project-edit"]').click();
      await $('[data-testid="virtual-project-name"]').waitForDisplayed();
      await browser.keys("Escape");
      await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
      await browser.refresh();
      await $(PROJECT).waitForDisplayed({ timeout: 45_000 });
      expect(await $(PROJECT).$('[data-testid="virtual-project-toggle"]').isEnabled()).toBe(true);
      expect(await $(PROJECT).getAttribute("data-primary-root-status")).toBe("missing");
      expect(await $(PROJECT).$('[data-testid="virtual-project-files"]').isEnabled()).toBe(false);
      await rename(moved, primary);
      await rename(singleMoved, singlePrimary);
      await rm(extra, { recursive: true });
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () => $(PROJECT).$('[data-testid="virtual-project-create-task"]').isEnabled(),
        {
          timeout: 15_000,
          timeoutMsg: "project still disabled after the primary folder was restored",
        },
      );
      await $(PROJECT).moveTo();
      const recoveredCreate = $(PROJECT).$('[data-testid="virtual-project-create-task"]');
      expect(await recoveredCreate.isEnabled()).toBe(true);
      expect(await $(PROJECT).$('[data-testid="virtual-project-files"]').isEnabled()).toBe(true);
      expect(await $(SINGLE_PROJECT).$('[data-testid="virtual-project-files"]').isEnabled()).toBe(
        true,
      );
      await recoveredCreate.click();
      await waitForWorkspaceApp(primary, 30_000);
      for (const action of ["button", "shortcut"] as const) {
        const before = await readTaskState(primary);
        if (action === "button") await $('[data-testid="task-new-button"]').click();
        else await invokeNewTaskShortcut();
        await browser.waitUntil(async () => (await readTaskState(primary)).focus > before.focus);
        expect((await readTaskState(primary)).task).toBeNull();
        expect((await readTaskState(primary)).project).toBe(beforeNewTask.project);
        expect(await readActive()).toBe(primary);
      }
      await rename(primary, moved);
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () => (await $(PROJECT).getAttribute("data-primary-root-status")) === "missing",
      );
      expect(await toggle.isEnabled()).toBe(true);
      // Narrow-layout check for the shared sidebar; device-size emulation does not count as real phone shared-host link coverage.
      await emulateViewport(390);
      await browser.waitUntil(() => browser.execute(() => innerWidth === 390));
      // The narrow layout collapses the sidebar automatically; after expanding it through the original toggle, verify the title and hint layout.
      await browser.waitUntil(() =>
        browser.execute(() =>
          document
            .querySelector('[data-workspace-sidebar-panel="true"]')!
            .classList.contains("pointer-events-none"),
        ),
      );
      await browser.execute(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')!.click(),
      );
      await browser.waitUntil(() =>
        browser.execute(() => {
          const panel = document.querySelector('[data-workspace-sidebar-panel="true"]')!;
          return (
            panel.getBoundingClientRect().width > 30 &&
            panel.getAnimations().every((animation) => animation.playState !== "running")
          );
        }),
      );
      for (const theme of ["zai-dark", "zai-light"]) {
        await browser.execute(
          (value) => (window as TestWindow).__testActions!.setTheme(value),
          theme,
        );
        for (const testId of [
          "virtual-project-toggle",
          "virtual-project-create-task",
          "virtual-project-files",
        ]) {
          await browser.keys("Escape");
          await browser.waitUntil(() =>
            browser.execute(() => !document.querySelector('[data-slot="tooltip-content"]')),
          );
          // After CDP size emulation, WebDriver pointer coordinates are still affected by native window scaling; send CSS viewport coordinates directly.
          const point = await browser.execute(
            ({ selector, testId }) => {
              const rect = document
                .querySelector(`${selector} [data-testid="${testId}"]`)!
                .parentElement!.getBoundingClientRect();
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            },
            { selector: PROJECT, testId },
          );
          await browser.electron.execute(async (electron, point) => {
            const window = electron.BrowserWindow.getAllWindows().find((item) => item.isVisible())!;
            for (const offset of [-2, 0])
              await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: point.x + offset,
                y: point.y,
                buttons: 0,
                pointerType: "mouse",
              });
          }, point);
          if (testId === "virtual-project-toggle") {
            await expectNoReason();
            continue;
          }
          await waitForReason();
          const bounds = await browser.execute((selector) => {
            const row = document
              .querySelector(`${selector} [data-testid="virtual-project-row"]`)!
              .getBoundingClientRect();
            const hint = document
              .querySelector('[data-slot="tooltip-content"]:not([data-state="closed"])')!
              .getBoundingClientRect();
            return { rowRight: row.right, hintLeft: hint.left, hintRight: hint.right };
          }, PROJECT);
          expect(bounds.rowRight).toBeLessThanOrEqual(390);
          expect(bounds.hintLeft).toBeGreaterThanOrEqual(0);
          expect(bounds.hintRight).toBeLessThanOrEqual(390);
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-390-${testId}-${theme}.png`),
          );
        }
      }
    } finally {
      // Do not delete the primary folder, which has become the active cwd; the runner reclaims the whole isolated HOME.
      await emulateViewport();
      await browser.execute(() => (window as TestWindow).__testActions!.setTheme("system"));
    }
  });
});

async function readTaskState(path: string) {
  return browser.execute((path) => {
    const state = (window as TestWindow).__zcodeSessionStoreE2E!.getState().getWorkspaceState(path);
    return {
      task: state.activeTaskId,
      project: state.draftProjectId,
      focus: state.draftFocusVersion,
    };
  }, path);
}

async function waitForNewTaskToastToClose() {
  await browser.waitUntil(
    () => browser.execute(() => !document.getElementById("zcode-toast-host")?.textContent?.trim()),
    { timeout: 5_000 },
  );
}

async function invokeNewTaskShortcut() {
  const url = await browser.getUrl();
  await browser.electron.execute((electron, url) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.getURL() === url,
    );
    if (!window) throw new Error("Missing new-task shortcut window");
    window.focus();
    const item = electron.Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((entry) => entry.accelerator === "CmdOrCtrl+N");
    if (!item) throw new Error("Missing CmdOrCtrl+N binding");
    // WebDriver DOM key presses bypass the system menu; verify the real accelerator binding and run the same command.
    item.click(undefined as never, window, undefined as never);
  }, url);
}

async function emulateViewport(width?: number) {
  await browser.electron.execute(async (electron, width) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
    );
    if (!window) throw new Error("No visible renderer");
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand(
      width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
      width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
    );
  }, width);
}

async function openEditor(name: string) {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').setValue(name);
}

async function chooseRoot(path: string) {
  await selectNativeProjectDirectories([path]);
}

async function expectNoReason() {
  // The negative hover assertion must dwell past the Tooltip delay, so it is not falsely passed before the hint opens.
  await browser.pause(1_000);
  const hints = await browser.execute(() =>
    [...document.querySelectorAll('[data-slot="tooltip-content"]:not([data-state="closed"])')].map(
      (element) => element.textContent,
    ),
  );
  expect(hints.some((text) => text?.includes(REASON))).toBe(false);
}

async function waitForReason() {
  // When a hint with the same text switches, the old node stays until the exit animation ends; only accept a visible hint that is expanded with its animation finished.
  // Radix's role=tooltip is a clipped screen-reader copy; the user-visible text lives in tooltip-content.
  await browser
    .waitUntil(() =>
      browser.execute((reason) => {
        const hint = document.querySelector<HTMLElement>(
          '[data-slot="tooltip-content"]:not([data-state="closed"])',
        );
        return Boolean(
          hint?.textContent?.includes(reason) &&
          Number(getComputedStyle(hint).opacity) === 1 &&
          hint.getAnimations().every((animation) => animation.playState !== "running"),
        );
      }, REASON),
    )
    .catch(async (error) => {
      const state = await browser.execute(
        (selector) => ({
          hints: [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => ({
            html: el.outerHTML,
            opacity: getComputedStyle(el).opacity,
          })),
          hovered: [...document.querySelectorAll(":hover")]
            .slice(-6)
            .map((el) => el.outerHTML.slice(0, 500)),
          trigger: document.querySelector(`${selector} [data-testid="virtual-project-create-task"]`)
            ?.parentElement?.outerHTML,
        }),
        PROJECT,
      );
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "tooltip-failure.png"),
      );
      throw new Error(JSON.stringify(state), { cause: error });
    });
}

async function leaveTooltip() {
  // Close the previous hint and move away, then verify the next entry's hover independently, so a stale hint with the same text cannot cause a false positive.
  if (await $('[data-slot="tooltip-content"]').isExisting()) await browser.keys("Escape");
  await $(
    '[data-project-name="E2E_EMPTY_PRIMARY"] [data-testid="virtual-project-toggle"]',
  ).moveTo();
  await browser.waitUntil(async () => !(await $('[data-slot="tooltip-content"]').isExisting()));
}

function seedHistory(workspacePath: string) {
  // Write only to the runner's isolated HOME; reuse the real Host/CLI two-database data contract without mocking messages or directory state.
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home || !DEFAULT_WORKSPACE.startsWith(home)) throw new Error("isolated HOME required");
  const app = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
  const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
  try {
    const projectId = app
      .prepare("SELECT project_id FROM project_roots WHERE root_path=? LIMIT 1")
      .get(workspacePath)?.project_id;
    if (typeof projectId !== "string") throw new Error("fixture project missing");
    const now = Date.now();
    cli
      .prepare(
        "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
      )
      .run(
        HISTORY_ID,
        "e2e-primary-history",
        HISTORY_ID,
        workspacePath,
        "E2E_PRIMARY_HISTORY",
        now,
        now,
      );
    cli
      .prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,0)",
      )
      .run(
        `${HISTORY_ID}_message`,
        HISTORY_ID,
        now,
        now,
        JSON.stringify({ role: "user", time: { created: now }, agent: "build" }),
      );
    cli
      .prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?,0)",
      )
      .run(
        `${HISTORY_ID}_part`,
        `${HISTORY_ID}_message`,
        HISTORY_ID,
        now,
        now,
        JSON.stringify({ type: "text", text: HISTORY_BODY }),
      );
    app
      .prepare(
        "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,mode,created_at,updated_at,host_id,root_path,project_id,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm','default',?,?,'local',?,?,?,'custom',?,?,'completed',0,?)",
      )
      .run(
        workspacePath,
        workspacePath,
        HISTORY_ID,
        "E2E_PRIMARY_HISTORY",
        now,
        now,
        workspacePath,
        projectId,
        "E2E_PRIMARY_HISTORY",
        now,
        now,
        JSON.stringify({
          taskId: HISTORY_ID,
          traceId: HISTORY_ID,
          title: "E2E_PRIMARY_HISTORY",
          workspacePath,
          createdAt: now,
          updatedAt: now,
          mode: "build",
        }),
      );
  } finally {
    cli.close();
    app.close();
  }
}
