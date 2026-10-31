import { mkdir } from "node:fs/promises";
import { basename as posixBasename } from "node:path/posix";
import { basename as win32Basename } from "node:path/win32";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  TID_VIRTUAL_PROJECT_CREATE_TASK,
  TID_VIRTUAL_PROJECT_FILES,
  TID_VIRTUAL_PROJECT_MENU,
  TID_VIRTUAL_PROJECT_ROW,
  TID_VIRTUAL_PROJECT_TOGGLE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  testId,
  virtualProjectActionTestId,
} from "@zcode/shared/test-ids";

/** Start a real project drag; the caller continues verifying and cancels via Escape / releaseActions. */
export async function startProjectPointerDrag(selector: string) {
  await browser.releaseActions();
  const position = await browser.execute((query) => {
    const rect = document.querySelector(query)!.getBoundingClientRect();
    return {
      x: Math.round(rect.left + 14),
      y: Math.round(rect.top + rect.height / 2),
      top: rect.top,
    };
  }, selector);
  await browser.performActions([
    {
      type: "pointer",
      id: "project-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: position.x, y: position.y, duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", x: position.x, y: position.y + 8, duration: 0 },
      ],
    },
  ]);
  // The cross-threshold event only activates the sensor; wait for that owner's state, then send the second movement, so event coalescing cannot zero out the displacement.
  await browser.waitUntil(async () => (await $(selector).getAttribute("aria-pressed")) === "true", {
    timeout: 5000,
    timeoutMsg: "项目拖拽未激活",
  });
  await browser.performActions([
    {
      type: "pointer",
      id: "project-drag",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", x: position.x, y: position.y + 24, duration: 0 }],
    },
  ]);
  return position;
}

/**
 * Project-sidebar E2E locating helper.
 *
 * After the 2026-09 virtual-project refactor the sidebar no longer renders real directory nodes
 * (the old TID_WORKSPACE_ITEM); old workspaces migrate on first run into a "same-named root
 * project": project name = directory basename (same rule as
 * packages/services/src/project-storage/migrate-projects.ts), and the project `<section>`
 * carries data-project-id / data-project-name. Locating is uniformly by project name here; the
 * E2E fixtures' workspace basenames are mutually unique (ZCodeProject, PassiveWorkspace-01…).
 */
export function projectNameForWorkspace(workspacePath: string): string {
  return (
    (workspacePath.includes("\\") ? win32Basename(workspacePath) : posixBasename(workspacePath)) ||
    workspacePath
  );
}

export function projectSectionSelector(workspacePath: string): string {
  return `[data-project-id][data-project-name=${JSON.stringify(projectNameForWorkspace(workspacePath))}]`;
}

export function projectRowSelector(workspacePath: string): string {
  return `${projectSectionSelector(workspacePath)} [data-testid="${TID_VIRTUAL_PROJECT_ROW}"]`;
}

interface WaitOptions {
  timeout?: number;
  timeoutMsg?: string;
}

async function projectRowExists(workspacePath: string): Promise<boolean> {
  try {
    return await browser.execute(
      (selector) => Boolean(document.querySelector(selector)),
      projectRowSelector(workspacePath),
    );
  } catch {
    // During a renderer reload the WebDriver briefly loses its execution context; treat it as not ready.
    return false;
  }
}

export async function waitForProjectRow(
  workspacePath: string,
  { timeout = 30_000, timeoutMsg = `侧栏没有显示项目: ${workspacePath}` }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(() => projectRowExists(workspacePath), {
    timeout,
    interval: 100,
    timeoutMsg,
  });
}

export async function waitForProjectRowGone(
  workspacePath: string,
  { timeout = 30_000, timeoutMsg = `项目移除后仍在侧栏: ${workspacePath}` }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(async () => !(await projectRowExists(workspacePath)), {
    timeout,
    interval: 100,
    timeoutMsg,
  });
}

/** Wait until all project rows for a set of workspaces appear in the sidebar (startup restore / first migration finished). */
export async function waitForRestoredProjects(
  workspacePaths: string[],
  timeout = 30_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const workspacePath of workspacePaths) {
        if (!(await projectRowExists(workspacePath))) return false;
      }
      return true;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${workspacePaths.length} 个恢复 workspace 没有全部出现在项目侧栏`,
    },
  );
}

/**
 * Project sidebar shell readiness: the project section is rendered and the occupation onboarding
 * (which replaces the whole main UI while it is shown) is gone. Both are DOM facts, not a delay.
 */
async function projectSidebarShellReady(): Promise<boolean> {
  try {
    return await browser.execute(
      () =>
        !document.querySelector('[data-testid="onboarding-page"]') &&
        Boolean(document.querySelector('[data-testid="project-section"]')),
    );
  } catch {
    // During a renderer reload the WebDriver briefly loses its execution context; treat it as not ready.
    return false;
  }
}

/**
 * Ensures the local project row exists, creating it through the real project form when missing.
 *
 * Root cause (ISSUE-024): the fork's Host deliberately does not seed projects from
 * lastWorkspaceSession (commit 46c33e9d), so the E2E index's projects table stays empty and waiting
 * for the row only times out. Nothing registers the row once the sidebar shell is up, so the
 * existence check runs once at that point and only then is the project created through the UI.
 * Rule: wait for a readiness signal, never for a fixed delay; the check stays idempotent so an
 * existing project is never duplicated. If a restore path ever registers projects after the shell
 * renders, this check must be tied to that path's completion signal instead.
 */
export async function ensureLocalProjectRow(
  workspacePath: string,
  { timeout = 30_000 }: { timeout?: number } = {},
): Promise<void> {
  await browser.waitUntil(projectSidebarShellReady, {
    timeout,
    interval: 100,
    timeoutMsg: "项目侧栏外壳没有就绪（项目区未渲染或职业引导仍在）",
  });
  if (await projectRowExists(workspacePath)) return;
  await mkdir(workspacePath, { recursive: true });
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed({ timeout });
  await selectNativeProjectDirectories([workspacePath]);
  await $('[data-testid="virtual-project-name"]').setValue(projectNameForWorkspace(workspacePath));
  await $('[data-testid="virtual-project-save"]').click();
  const trustConfirm = $('[data-testid="project-folder-trust-confirm"]');
  const needsTrust = await trustConfirm.waitForDisplayed({ timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (needsTrust) await trustConfirm.click();
  await waitForProjectRow(workspacePath, { timeout });
}

async function readProjectExpanded(workspacePath: string): Promise<boolean> {
  return browser.execute(
    (selector, toggleTestId) =>
      document
        .querySelector(selector)
        ?.querySelector(`[data-testid="${toggleTestId}"]`)
        ?.getAttribute("aria-expanded") === "true",
    projectSectionSelector(workspacePath),
    TID_VIRTUAL_PROJECT_TOGGLE,
  );
}

/** Ensure the project row is expanded (task list visible); replaces the old ensureWorkspaceItemExpanded. */
export async function ensureProjectExpanded(
  workspacePath: string,
  timeout = 30_000,
): Promise<void> {
  await waitForProjectRow(workspacePath, { timeout });
  if (!(await readProjectExpanded(workspacePath))) {
    await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_TOGGLE, {
      timeout: 15_000,
      timeoutMsg: `侧栏项目不可展开: ${workspacePath}`,
    });
  }
  // Bug root cause: in slow-render environments a successful DOM click only proves the event
  // was dispatched; the project tree's React expansion may still commit in a later frame.
  // Uniformly wait for the aria end state so cases do not look for tasks too early.
  await browser.waitUntil(() => readProjectExpanded(workspacePath), {
    timeout: 15_000,
    timeoutMsg: `侧栏项目没有完成展开: ${workspacePath}`,
  });
}

/** Really hover a project row; the hover action area (file tree / new task / more) mounts with hover opacity. */
export async function hoverProjectRow(workspacePath: string, timeout = 15_000): Promise<void> {
  const row = $(projectRowSelector(workspacePath));
  await row.waitForDisplayed({ timeout, timeoutMsg: `侧栏没有可悬停的项目行: ${workspacePath}` });
  await row.moveTo();
}

/** DOM-click a data-testid inside the project section (toggle / files / create-task / menu…). */
export async function clickProjectAction(
  workspacePath: string,
  actionTestId: string,
  {
    timeout = 15_000,
    timeoutMsg = `项目 ${workspacePath} 没有可点击的 ${actionTestId}`,
  }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, targetTestId) => {
          const target = document
            .querySelector(selector)
            ?.querySelector<HTMLButtonElement>(`[data-testid="${targetTestId}"]`);
          if (!target || target.disabled) return false;
          target.click();
          return true;
        },
        projectSectionSelector(workspacePath),
        actionTestId,
      ),
    { timeout, interval: 100, timeoutMsg },
  );
}

/** Open the project's primary-directory file-tree panel; replaces the old "hover workspace row → file-tree button". */
export async function openProjectFileTree(
  workspacePath: string,
  { timeout = 15_000, timeoutMsg = "没有找到项目文件树入口" }: WaitOptions = {},
): Promise<void> {
  await hoverProjectRow(workspacePath, timeout);
  await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_FILES, { timeout, timeoutMsg });
  await browser.waitUntil(
    () =>
      browser.execute(
        (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
        TID_WORKSPACE_FILE_TREE_PANEL,
      ),
    { timeout, timeoutMsg: "文件树面板没有打开" },
  );
}

/** Start a new task draft from the project row (cwd = the project's primary directory). */
export async function startDraftFromProject(
  workspacePath: string,
  options: { workspaceIdentity?: string } = {},
): Promise<void> {
  let workspaceIdentity = options.workspaceIdentity?.trim();
  if (!workspaceIdentity) {
    const project = $(projectSectionSelector(workspacePath));
    await project.waitForDisplayed({ timeout: 30_000 });
    workspaceIdentity =
      (await project.getAttribute("data-project-workspace-identity")) || undefined;
  }
  // Remote drafts are stored by Source identity; with only a path given, read the identity from the target project too — never keep waiting for a path key that does not exist.
  const draftKey = workspaceIdentity || workspacePath;
  const previousDraftVersion = await browser.execute((key) => {
    const bridge = (
      window as unknown as {
        __zcodeSessionStoreE2E?: {
          getState(): { workspaces: Record<string, { draftFocusVersion?: number }> };
        };
      }
    ).__zcodeSessionStoreE2E;
    return bridge?.getState().workspaces[key]?.draftFocusVersion ?? 0;
  }, draftKey);
  if (workspaceIdentity) {
    // Same-named same-path projects can exist across Sources; with an explicit identity, do not fall back to the first name match.
    const project = $(`[data-project-workspace-identity=${JSON.stringify(workspaceIdentity)}]`);
    await project.waitForDisplayed({ timeout: 30_000 });
    await project.moveTo();
    await project.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
  } else {
    await hoverProjectRow(workspacePath);
    await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_CREATE_TASK, {
      timeoutMsg: `项目 ${workspacePath} 没有可用的新建任务入口`,
    });
  }
  // Merge adaptation: when switching projects the exit animation briefly keeps the old input
  // box; waiting only on the navigation path would send into the old session. Count only the
  // main pane; side chats legitimately keep their own input box, so the page must not be
  // required to have exactly one input left. Wait for the old main-pane input to be removed,
  // then confirm the target project's empty draft, preventing sends to the exiting session.
  await browser.waitUntil(
    () =>
      browser.execute(
        (inputId, panePrefix, workspaceTriggerId, projectName, identity, key, previousVersion) => {
          const inputs = document.querySelectorAll(
            `[data-testid="${panePrefix}-workspace-main"] [data-testid="${inputId}"]`,
          );
          const pane = inputs[0]?.closest<HTMLElement>(`[data-testid^="${panePrefix}-"]`);
          const trigger = document.querySelector<HTMLElement>(
            `[data-testid="${workspaceTriggerId}"]`,
          );
          const activeIdentity = identity
            ? (
                window as Window & {
                  __zcodeTabStoreE2E?: {
                    getState(): { activeWorkspaceIdentity?: string | null };
                  };
                }
              ).__zcodeTabStoreE2E?.getState().activeWorkspaceIdentity
            : undefined;
          return (
            // Directory preparation is async; when the same project already shows a draft, old DOM cannot prove this new draft was committed.
            ((
              window as unknown as {
                __zcodeSessionStoreE2E?: {
                  getState(): { workspaces: Record<string, { draftFocusVersion?: number }> };
                };
              }
            ).__zcodeSessionStoreE2E?.getState().workspaces[key]?.draftFocusVersion ?? 0) >
              previousVersion &&
            (!identity || activeIdentity === identity) &&
            inputs.length === 1 &&
            pane?.dataset.sessionId === "draft" &&
            trigger?.innerText.trim() === projectName
          );
        },
        TID_V4_COMPOSER_INPUT,
        TID_V4_SESSION_PANE,
        TID_COMPOSER_WORKSPACE_TRIGGER,
        projectNameForWorkspace(workspacePath),
        workspaceIdentity,
        draftKey,
        previousDraftVersion,
      ),
    { timeout: 30_000, timeoutMsg: `项目 ${workspacePath} 的新任务输入框尚未就绪` },
  );
}

/** Open the project row's "more" menu and pick an action (edit / pin / delete / remove-entry). */
export async function openProjectMenuAction(
  workspacePath: string,
  actionId: string,
  { timeout = 30_000 }: WaitOptions = {},
): Promise<void> {
  await hoverProjectRow(workspacePath, timeout);
  // Bug root cause: Radix DropdownMenu triggers rely on pointerdown gestures; element.click()
  // dispatching only click does not open the portal menu. Complete the pointer chain here.
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, menuTestId) => {
          const trigger = document
            .querySelector(selector)
            ?.querySelector<HTMLButtonElement>(`[data-testid="${menuTestId}"]`);
          if (!trigger || trigger.disabled) return false;
          trigger.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
          trigger.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
          );
          trigger.click();
          return true;
        },
        projectSectionSelector(workspacePath),
        TID_VIRTUAL_PROJECT_MENU,
      ),
    { timeout, timeoutMsg: `项目 ${workspacePath} 没有显示更多菜单入口` },
  );
  const itemTestId = virtualProjectActionTestId(actionId);
  await browser.waitUntil(
    () =>
      browser.execute((targetTestId) => {
        const item = document.querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`);
        if (!item || item.getAttribute("aria-disabled") === "true") return false;
        item.click();
        return true;
      }, itemTestId),
    { timeout: 15_000, timeoutMsg: `项目 ${workspacePath} 菜单没有 ${actionId} 动作` },
  );
}

export interface ProjectTaskRowState {
  active: boolean;
  error: boolean;
  exists: boolean;
  inProject: boolean;
  running: boolean;
}

/** Read whether a task row exists inside the target project section and its display state. */
export async function readProjectTaskRowState(
  taskId: string,
  workspacePath: string,
): Promise<ProjectTaskRowState> {
  return browser.execute(
    (taskTestId, sectionSelector) => {
      const taskRow = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === taskTestId,
      );
      const section = document.querySelector(sectionSelector);
      return {
        active: taskRow?.classList.contains("bg-selected") ?? false,
        error: Boolean(taskRow?.querySelector('[data-error-indicator="true"]')),
        exists: Boolean(taskRow),
        inProject: Boolean(taskRow && section?.contains(taskRow)),
        running: Boolean(taskRow?.querySelector(".animate-spin")),
      };
    },
    testId(TID_TASK_ITEM, taskId),
    projectSectionSelector(workspacePath),
  );
}

export async function waitForTaskRowInProject(
  taskId: string,
  workspacePath: string,
  {
    timeout = 30_000,
    timeoutMsg = `task ${taskId} 没有出现在项目 ${workspacePath} 下`,
  }: WaitOptions = {},
): Promise<void> {
  await waitForProjectRow(workspacePath, { timeout });
  await browser.waitUntil(
    async () => {
      // For a remote project while offline, the toggle is disabled and the task list is not
      // rendered; expand best-effort here and let the task row's own appearance be the evidence
      // that the host is back online and the task is in place.
      if (!(await readProjectExpanded(workspacePath))) {
        await browser.execute(
          (selector, toggleTestId) => {
            const toggle = document
              .querySelector(selector)
              ?.querySelector<HTMLButtonElement>(`[data-testid="${toggleTestId}"]`);
            if (toggle && !toggle.disabled) toggle.click();
          },
          projectSectionSelector(workspacePath),
          TID_VIRTUAL_PROJECT_TOGGLE,
        );
      }
      const state = await readProjectTaskRowState(taskId, workspacePath);
      return state.exists && state.inProject && !state.error;
    },
    { timeout, interval: 250, timeoutMsg },
  );
}

/** Remote identity comes from the project row; there is no Host wrapper layer anymore. */
export async function readRemoteHostIdForProject(workspacePath: string): Promise<string | null> {
  return browser.execute(
    (selector) => document.querySelector(selector)?.getAttribute("data-project-host") ?? null,
    projectSectionSelector(workspacePath),
  );
}

/** Device connection actions live in the project row menu and still go through the same Host connection port. */
export async function clickRemoteHostConnect(
  workspacePath: string,
  options: WaitOptions = {},
): Promise<void> {
  await openProjectMenuAction(workspacePath, "connect", options);
}

/** Only replaces the system dialog's user choice; the real renderer → preload → main multi-directory chain stays. */
export async function selectNativeProjectDirectories(paths: string[]) {
  const picker = await browser.electron.mock("dialog", "showOpenDialog");
  try {
    await picker.mockResolvedValueOnce({ canceled: paths.length === 0, filePaths: paths });
    await $('[data-testid="virtual-project-browse"]').click();
    await expect(picker).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    await $('[data-testid="virtual-project-save"]').waitForEnabled();
    expect(await $('[data-testid="virtual-project-directory-browser"]').isExisting()).toBe(false);
    for (const path of paths) {
      await $(
        `[data-testid="virtual-project-root-name"][title=${JSON.stringify(path)}]`,
      ).waitForDisplayed();
    }
  } finally {
    await picker.mockRestore();
  }
}

/** Remote directories are browsed by their owning Host, not via this machine's system file picker. */
export async function selectRemoteProjectDirectory(path: string) {
  if (!(await $('[data-testid="virtual-project-directory-browser"]').isDisplayed()))
    await $('[data-testid="virtual-project-browse"]').click();
  const picker = $('[data-testid="virtual-project-directory-browser"]');
  const input = picker.$('input[type="text"]');
  await input.waitForDisplayed();
  await browser.waitUntil(async () => Boolean(await input.getValue()));
  await browser.execute((value) => {
    const element = document.querySelector<HTMLInputElement>(
      '[data-testid="virtual-project-directory-browser"] input[type="text"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, path);
  await input.click();
  await browser.keys("Enter");
  const select = picker.$(
    './/button[normalize-space(.)="选择文件夹" or normalize-space(.)="Choose folder"]',
  );
  await select.waitForEnabled();
  await select.click();
  await picker.waitForExist({ reverse: true });
  await $(
    `[data-testid="virtual-project-root-name"][title=${JSON.stringify(path)}]`,
  ).waitForDisplayed();
}
