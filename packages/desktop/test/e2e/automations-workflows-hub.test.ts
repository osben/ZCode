import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_AUTOMATIONS_OPEN,
  TID_AUTOMATIONS_PAGE_TAB,
  TID_CHAT_SUMMARY_PANEL,
  TID_CHAT_WORKFLOW_RUN_DIGEST,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
  TID_V4_TIMELINE,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  TID_WORKFLOW_ARTIFACT_CARD,
  TID_WORKFLOW_ARTIFACT_PANE,
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_MENU,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_DETAIL_DESCRIPTION,
  TID_WORKFLOW_DETAIL_MENU,
  TID_WORKFLOW_GLOBAL_GROUP,
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
  TID_WORKFLOW_LAUNCH_ERROR,
  TID_WORKFLOW_LAUNCH_SUBMIT,
  TID_WORKFLOW_META_SAVE,
  TID_WORKFLOW_MOVE_DIALOG,
  TID_WORKFLOW_MOVE_DIALOG_SUBMIT,
  TID_WORKFLOW_PROJECT_GROUP,
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  seedSettings,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "./helpers/desktop-app.js";
import {
  getMessages,
  prepareConversationE2E,
  waitForUserMessageContaining,
} from "./helpers/conversation-session.js";
import { getV4ComposerBackgroundWorkCounts } from "./helpers/v4-conversation.js";

const WORKFLOW_NAME = "release-check";
const WORKFLOWS_DIR = join(DEFAULT_WORKSPACE, ".zcode", "workflows");
const WORKFLOW_FILE = join(WORKFLOWS_DIR, `${WORKFLOW_NAME}.dwf.ts`);
const EDITED_DESCRIPTION = "发布前检查（E2E 已编辑）";
// Script body: metadata edits only rewrite the frontmatter at the top of the file, so this part must be preserved
// byte for byte (invariant 4).
const SCRIPT = [
  "export default async ({ agent }) => {",
  '  await agent("跑测试并整理发布说明");',
  "};",
  "",
].join("\n");
const SEED = [
  "/* zcode-workflow",
  "description: 发布前检查",
  "whenToUse: 准备发版时",
  "args:",
  "  branch:",
  "    type: string",
  "    required: true",
  "*/",
  SCRIPT,
].join("\n");

interface GroupHeaderInfo {
  groupTestId: string | null;
  text: string;
  createTestId: string | null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTestIdText(currentTestId: string): Promise<string | null> {
  return browser.execute((tid) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid,
    );
    return element?.textContent?.trim() ?? null;
  }, currentTestId);
}

/**
 * End-to-end "list → detail → edit metadata → delete" for the saved-workflows hub (docs/dynamic-workflow/launch.md).
 *
 * Only touches the UI + `.zcode/workflows/` in the project directory: no prompt is sent and no model replay is
 * required, so it is deterministic. The "run via conversation" cases are filed separately under conversation-session/
 * (they need a replay provider).
 */
// Assertions read literal zh-CN dialog text while the runner machine defaults to en-US, so pin
// the locale through the real settings file and reload, matching the feishu specs' convention.
async function ensureZhCnLocale() {
  await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
  await browser.refresh();
}

describe("已保存工作流中枢 E2E", () => {
  before(async () => {
    await ensureZhCnLocale();
    await mkdir(WORKFLOWS_DIR, { recursive: true });
    await writeFile(WORKFLOW_FILE, SEED, "utf-8");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(WORKFLOWS_DIR, { recursive: true, force: true });
    await clearAppData();
  });

  it("预置的工作流可见，改说明只重写 frontmatter，删除后回到空态", async function () {
    this.timeout(150000);

    // Only login + workspace readiness are needed to enter the automations page; no model provider needs to be configured.
    await prepareConversationE2E({ skipProvider: true });

    // 1) Open the automations page; the page title switches to "Workflows".
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现自动化入口",
    });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });

    // 2) The global view groups by project: the default workspace (folder named ZCodeProject) forms its own group,
    //    the group header carries the name, and the group's "create via chat" button carries a test id ending in the
    //    workspaceKey. The test id suffix of group / create is the workspaceKey (locally usually = workspacePath), but
    //    if resolveWorkspaceKey normalizes local paths (casing / trailing slash / realpath) the suffix will not equal
    //    DEFAULT_WORKSPACE — so we wait and assert by prefix only, never pinning the whole string.
    const readGroupInfo = () =>
      browser.execute(
        (groupPrefix: string, createPrefix: string) => {
          const group = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) => item.dataset.testid?.startsWith(groupPrefix),
          );
          if (!group) return null;
          const createButton = group.querySelector<HTMLElement>(`[data-testid^="${createPrefix}"]`);
          return {
            groupTestId: group.dataset.testid ?? null,
            text: group.textContent ?? "",
            createTestId: createButton?.dataset.testid ?? null,
          };
        },
        TID_WORKFLOW_PROJECT_GROUP,
        // testId(base, "") = `${base}-`: prefix of the create button's test id.
        testId(TID_WORKFLOWS_CREATE_VIA_CHAT, ""),
      ) as Promise<GroupHeaderInfo | null>;

    let groupInfo: GroupHeaderInfo | null = null;
    await browser.waitUntil(
      async () => {
        groupInfo = await readGroupInfo();
        return Boolean(groupInfo && groupInfo.createTestId);
      },
      { timeout: 20000, timeoutMsg: "工作流页没有出现默认工作区的项目组" },
    );
    const seen = groupInfo as GroupHeaderInfo | null;
    expect(seen?.groupTestId?.startsWith(TID_WORKFLOW_PROJECT_GROUP)).toBe(true);
    expect(seen?.text).toContain("ZCodeProject");
    expect(seen?.createTestId?.startsWith(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, ""))).toBe(true);
    expect(seen?.createTestId).toContain("ZCodeProject");

    // 3) The seeded file appears as a card: name + the description from the frontmatter.
    const cardTestId = testId(TID_WORKFLOW_CARD, WORKFLOW_NAME);
    await waitForTestIdByDom(cardTestId, {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现预置的 release-check 卡片",
    });
    expect(await readTestIdText(cardTestId)).toContain("发布前检查");

    // 4) Click the card into detail view, edit the description, and save.
    await clickTestIdByDom(cardTestId, { timeoutMsg: "无法点击工作流卡片进入详情" });
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL, { timeoutMsg: "没有进入工作流详情页" });
    await setInputValueByTestIdDom(TID_WORKFLOW_DETAIL_DESCRIPTION, EDITED_DESCRIPTION, {
      timeoutMsg: "详情页没有出现说明输入框",
    });
    await clickTestIdByDom(TID_WORKFLOW_META_SAVE, {
      timeoutMsg: "改说明后没有出现「保存元数据」",
    });

    // 5) Disk: frontmatter updated, script body unchanged byte for byte.
    await browser.waitUntil(
      async () => (await readFile(WORKFLOW_FILE, "utf-8")).includes(EDITED_DESCRIPTION),
      { timeout: 15000, timeoutMsg: "保存后磁盘文件的说明没有更新" },
    );
    const saved = await readFile(WORKFLOW_FILE, "utf-8");
    expect(saved.startsWith("/* zcode-workflow\n")).toBe(true);
    expect(saved.endsWith(`*/\n${SCRIPT}`)).toBe(true);
    expect(saved).toContain("whenToUse: 准备发版时");
    expect(saved).toContain("required: true");

    // 6) Detail page ⋯ menu → delete → confirm twice → back to the empty list state, file gone.
    await clickTestIdByWebDriver(TID_WORKFLOW_DETAIL_MENU, {
      timeoutMsg: "详情页没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_DELETE, WORKFLOW_NAME), {
      timeoutMsg: "详情页菜单没有「删除工作流」项",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeoutMsg: "删除二次确认弹窗没有出现",
    });
    await waitForTestIdByDom(TID_WORKFLOWS_EMPTY, {
      timeout: 15000,
      timeoutMsg: "删除后没有回到工作流空态",
    });
    await browser.waitUntil(async () => !(await fileExists(WORKFLOW_FILE)), {
      timeout: 10000,
      timeoutMsg: "删除后磁盘文件仍然存在",
    });
  });
});

// ── Global workflows: pinned "Global" group + global→project file move + project→global AI summary
// (docs/dynamic-workflow/launch.md) ──
// E2E_HOME_DIR is set by the wdio config to an isolated directory written into HOME (wdio.conf.ts:520), and both the
// app and agent processes inherit it, so the agent's os.homedir() resolves here and the global root =
// `<E2E_HOME>/.zcode/workflows/`.
const E2E_HOME = dirname(DEFAULT_WORKSPACE);
const GLOBAL_WORKFLOW_NAME = "global-note";
const GLOBAL_WORKFLOWS_DIR = join(E2E_HOME, ".zcode", "workflows");
const GLOBAL_WORKFLOW_FILE = join(GLOBAL_WORKFLOWS_DIR, `${GLOBAL_WORKFLOW_NAME}.dwf.ts`);
const GLOBAL_PROJECT_WORKFLOWS_DIR = join(DEFAULT_WORKSPACE, ".zcode", "workflows");
const GLOBAL_PROJECT_WORKFLOW_FILE = join(
  GLOBAL_PROJECT_WORKFLOWS_DIR,
  `${GLOBAL_WORKFLOW_NAME}.dwf.ts`,
);
// A global workflow without args: "Move to project…" copies the file byte for byte, so the script body must be
// identical on both ends.
const GLOBAL_SCRIPT = [
  "export default async ({ agent }) => {",
  '  await agent("做一次深度调研");',
  "};",
  "",
].join("\n");
const GLOBAL_SEED = [
  "/* zcode-workflow",
  "description: 深度调研（全局）",
  "*/",
  GLOBAL_SCRIPT,
].join("\n");

describe("全局工作流中枢 E2E", () => {
  before(async () => {
    await ensureZhCnLocale();
    await mkdir(GLOBAL_WORKFLOWS_DIR, { recursive: true });
    await writeFile(GLOBAL_WORKFLOW_FILE, GLOBAL_SEED, "utf-8");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(GLOBAL_WORKFLOW_FILE, { force: true });
    await rm(GLOBAL_PROJECT_WORKFLOW_FILE, { force: true });
    await clearAppData();
  });

  it("全局组置顶；全局→项目搬文件；项目→全局开新会话发概括提示、文件不动", async function () {
    this.timeout(150000);

    await prepareConversationE2E({ skipProvider: true });

    // 1) Automations page → "Workflows" tab.
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });

    // 2) The "Global" group appears at the top and contains the seeded global-note card.
    await waitForTestIdByDom(TID_WORKFLOW_GLOBAL_GROUP, {
      timeout: 20000,
      timeoutMsg: "工作流页没有出现「全局」组",
    });
    const globalCardTestId = testId(TID_WORKFLOW_CARD, GLOBAL_WORKFLOW_NAME);
    await waitForTestIdByDom(globalCardTestId, {
      timeout: 20000,
      timeoutMsg: "「全局」组里没有出现预置的 global-note 卡片",
    });

    // 3) Card ⋯ → "Move to project…" → move dialog → submit.
    await clickTestIdByWebDriver(testId(TID_WORKFLOW_CARD_MENU, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "全局卡片没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_MOVE, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "全局卡片菜单没有「移到项目…」项",
    });
    await waitForTestIdByDom(TID_WORKFLOW_MOVE_DIALOG, { timeoutMsg: "没有出现「移到项目」窗" });
    await clickTestIdByDom(TID_WORKFLOW_MOVE_DIALOG_SUBMIT, {
      timeoutMsg: "「移到项目」窗没有提交按钮",
    });

    // 4) Disk: the file has moved into the project directory and is gone from HOME.
    await browser.waitUntil(async () => fileExists(GLOBAL_PROJECT_WORKFLOW_FILE), {
      timeout: 15000,
      timeoutMsg: "移到项目后文件没有出现在项目目录",
    });
    await browser.waitUntil(async () => !(await fileExists(GLOBAL_WORKFLOW_FILE)), {
      timeout: 10000,
      timeoutMsg: "移到项目后 HOME 里的文件仍然存在",
    });

    // 5) The card now sits in the project group, and the "Global" group still sits above the project group
    //    (compare DOM order).
    const projectGroupTestId = await browser.waitUntil(
      async () => {
        const tid = await browser.execute((prefix: string) => {
          const group = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) => item.dataset.testid?.startsWith(prefix),
          );
          return group?.dataset.testid ?? null;
        }, TID_WORKFLOW_PROJECT_GROUP);
        return tid ?? false;
      },
      { timeout: 15000, timeoutMsg: "移到项目后没有出现项目组" },
    );
    const order = await browser.execute(
      (globalTid: string, projectTid: string) => {
        const globalEl = document.querySelector<HTMLElement>(`[data-testid="${globalTid}"]`);
        const projectEl = document.querySelector<HTMLElement>(`[data-testid="${projectTid}"]`);
        if (!globalEl || !projectEl) return null;
        // Node.DOCUMENT_POSITION_FOLLOWING = 4: project comes after global.
        return (globalEl.compareDocumentPosition(projectEl) & 4) !== 0
          ? "global-first"
          : "project-first";
      },
      TID_WORKFLOW_GLOBAL_GROUP,
      projectGroupTestId as string,
    );
    expect(order).toBe("global-first");
    // The card is still visible (in the project group at this point).
    await waitForTestIdByDom(globalCardTestId, { timeoutMsg: "移到项目后卡片消失了" });

    // 6) Project card ⋯ → "Promote to global" (2026-09-04 addendum): no file is moved; instead a new session opens in
    //    this project and a summary prompt is sent automatically (createSession.firstInput). Assertions: the app switches
    //    to the new session, the first user message contains the workflow name, the path, and the scope: "global"
    //    instruction; neither file copy is touched (invariant 9: promotion neither moves nor deletes). The model turn
    //    itself is not asserted (with skipProvider there is no provider, so whether that hop fails is irrelevant to this
    //    feature).
    await clickTestIdByWebDriver(testId(TID_WORKFLOW_CARD_MENU, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "项目卡片没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_MOVE, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "项目卡片菜单没有「提升为全局」项",
    });
    await waitForUserMessageContaining(GLOBAL_WORKFLOW_NAME);
    const promoteMessage = (await getMessages("user")).find((message) =>
      message.text.includes(GLOBAL_WORKFLOW_NAME),
    );
    expect(promoteMessage?.text ?? "").toContain(GLOBAL_PROJECT_WORKFLOW_FILE);
    expect(promoteMessage?.text ?? "").toContain('scope: "global"');
    // Files untouched: the project file is still there and no same-named file was moved back into HOME.
    expect(await fileExists(GLOBAL_PROJECT_WORKFLOW_FILE)).toBe(true);
    expect(await fileExists(GLOBAL_WORKFLOW_FILE)).toBe(false);
  });
});

// ── Direct launch: hub "Run" → launch card at the top of a new session (docs/dynamic-workflow/launch.md) ──
// Like the two groups above, only touches the UI + `.zcode/workflows/` in the project directory, and deliberately uses
// constant workflows **without agent()/model calls**: none of the run's subagents ever start, so the whole path
// (create session → startSavedWorkflow → run settlement) needs no provider replay and reaches completed under
// skipProvider. After the run reaches a terminal state, the existing completion-notification turn fires (that hop is the
// first to need a model); this group **deliberately asserts only up to the launch card reaching completed** and does not
// depend on the model — consistent with the spec test map's "the completion notification turn follows the existing replay
// convention or asserts only up to the notification behavior".
const LAUNCH_OK_NAME = "direct-launch-ok";
const LAUNCH_OK_ARG = "topic";
const LAUNCH_OK_ARG_VALUE = "adaptive concurrency in agent runtimes";
const LAUNCH_OK_FILE = join(WORKFLOWS_DIR, `${LAUNCH_OK_NAME}.dwf.ts`);
// Script body: no agent(), returns a constant immediately. Declares a required arg `topic` so that "Run" pops the args
// dialog (arg-less project files run on click with no dialog; see the spec). Compiles cleanly (`return <literal>` is a
// legal script body).
const LAUNCH_OK_SEED = [
  "/* zcode-workflow",
  "description: 常量工作流（直接启动 E2E）",
  "args:",
  "  topic:",
  "    type: string",
  "    required: true",
  "*/",
  "return { ok: true };",
  "",
].join("\n");

// A constant workflow that runs for a while (composer badge direct-open E2E, docs/dynamic-workflow/presentation.md):
// zero agents, zero provider; it stays running via `world.run("sleep", …)` — the only sandbox means that needs no model
// yet keeps a run parked (the sandbox realm only has ES intrinsics, no setTimeout). cmd is a compile-time literal, and
// direct launch compiles it into declaredRunCommands, so no confirmation dialog is needed. Arg-less project files run
// on "Run" without popping the args dialog.
// Note: `sleep` depends on a POSIX environment; desktop e2e only runs in macOS / Linux containers.
const LAUNCH_SLEEP_NAME = "direct-launch-sleeping";
const LAUNCH_SLEEP_FILE = join(WORKFLOWS_DIR, `${LAUNCH_SLEEP_NAME}.dwf.ts`);
const LAUNCH_SLEEP_SEED = [
  "/* zcode-workflow",
  "description: 停留 running 的常量工作流（composer 徽标直达 E2E）",
  "*/",
  'await world.run("sleep", ["40"]);',
  "return { ok: true };",
  "",
].join("\n");

// Save / run again (docs/dynamic-workflow/transcript-and-notifications.md, "Saving the run, and running it again"):
// an arg-less project file that runs on "Run". Its script body is verbatim-different from the other constant workflows
// in this group — the "recognize as saved by the copy the run executed" rule must only match this one.
const LAUNCH_SAVE_NAME = "direct-launch-save";
const LAUNCH_SAVE_FILE = join(WORKFLOWS_DIR, `${LAUNCH_SAVE_NAME}.dwf.ts`);
const LAUNCH_SAVE_SCRIPT = "return { ok: true, savedFromRun: 1 };\n";
const LAUNCH_SAVE_SEED = [
  "/* zcode-workflow",
  "description: 保存与再次运行（直接启动 E2E）",
  "*/",
  LAUNCH_SAVE_SCRIPT,
].join("\n");

// "Open as file" (docs/dynamic-workflow/authoring.md, "How the user sees them"): a zero-agent constant workflow
// publishes a markdown artifact; after the run completes, open the artifact tab from the side pane and click
// "Open as file". The system-default-app hop is caught by the shell.openPath mock — we assert the path it received and
// that this version's bytes really landed at that path.
const LAUNCH_ARTIFACT_NAME = "direct-launch-artifact";
const LAUNCH_ARTIFACT_FILE = join(WORKFLOWS_DIR, `${LAUNCH_ARTIFACT_NAME}.dwf.ts`);
const LAUNCH_ARTIFACT_ID = "e2e-report";
const LAUNCH_ARTIFACT_MARKDOWN = "# E2E 报告\n\n作为文件打开。\n";
const LAUNCH_ARTIFACT_SEED = [
  "/* zcode-workflow",
  "description: 发布 markdown 产物（作为文件打开 E2E）",
  "*/",
  `await artifact.markdown(${JSON.stringify(LAUNCH_ARTIFACT_ID)}, ${JSON.stringify(
    LAUNCH_ARTIFACT_MARKDOWN,
  )}, { title: "E2E 报告" });`,
  "return { ok: true };",
  "",
].join("\n");

const LAUNCH_FAIL_NAME = "direct-launch-broken";
const LAUNCH_FAIL_FILE = join(WORKFLOWS_DIR, `${LAUNCH_FAIL_NAME}.dwf.ts`);
// The frontmatter stays legal (the card still appears and the args dialog still pops), but the script body carries a
// type error (TS2322: assigning a string to a number). Compilation only happens in stage ② of launch, so the error
// comes back as compile_failed in startSavedWorkflow's ACK and is caught by the args dialog's inline error area — the
// session does not exist before that point (invariant 2).
const LAUNCH_FAIL_SEED = [
  "/* zcode-workflow",
  "description: 编译失败工作流（直接启动 E2E）",
  "args:",
  "  topic:",
  "    type: string",
  "    required: true",
  "*/",
  'const answer: number = "not a number";',
  "return answer;",
  "",
].join("\n");

// The script names a model absent from the local catalog (docs/dynamic-workflow/launch.md, "Models the script names"):
// compilation itself is clean, and an unresolvable name is rejected via 9011 on the same path as compile diagnostics
// (compile_failed). The script only **declares** this subagent and never asks it, so even if resolution unexpectedly
// let it through, the provider would never be touched.
const LAUNCH_MODEL_NAME = "direct-launch-unknown-model";
const LAUNCH_MODEL_FILE = join(WORKFLOWS_DIR, `${LAUNCH_MODEL_NAME}.dwf.ts`);
const LAUNCH_MODEL_UNKNOWN = "no-such-model-e2e";
const LAUNCH_MODEL_SEED = [
  "/* zcode-workflow",
  "description: 点名未知模型的工作流（直接启动 E2E）",
  "args:",
  "  topic:",
  "    type: string",
  "    required: true",
  "*/",
  `agent("judge", { model: "${LAUNCH_MODEL_UNKNOWN}" });`,
  "return 1;",
  "",
].join("\n");

/** Read the visible text of the testid element matched by prefix (the launch card / task item test id suffix is a key only known at runtime). */
async function readTestIdPrefixText(prefix: string): Promise<string | null> {
  return browser.execute((currentPrefix) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid?.startsWith(currentPrefix),
    );
    return element?.textContent?.replace(/ /g, " ").trim() ?? null;
  }, prefix);
}

/**
 * The run status (`data-workflow-run-status`) of the launch-turn run card; null when the card is absent. What grows at
 * the top of a direct-launch session is the ordinary turn-tail run card (docs/dynamic-workflow/presentation.md,
 * "The run card"), not some other card.
 */
async function readLaunchCardStatus(): Promise<string | null> {
  return browser.execute(
    (prefix) => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (item) => item.dataset.testid?.startsWith(prefix),
      );
      return card?.getAttribute("data-workflow-run-status") ?? null;
    },
    testId(TID_CHAT_WORKFLOW_RUN_DIGEST, ""),
  );
}

/** Read the visible text of the run details side pane's provenance section (docs/dynamic-workflow/launch.md, "The launch turn"). */
async function readLaunchProvenanceText(): Promise<string | null> {
  return browser.execute(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="workflow-run-provenance"]');
    return element?.textContent?.trim() ?? null;
  });
}

/** Number of sidebar task items (the compile_failed case compares it before and after submission). */
async function countTaskItems(): Promise<number> {
  return browser.execute(
    (prefix) => document.querySelectorAll(`[data-testid^="${prefix}"]`).length,
    testId(TID_TASK_ITEM, ""),
  );
}

/** Concatenated text of all sidebar task items (asserts the workflow name appears in the session title). */
async function readTaskItemsText(): Promise<string> {
  return browser.execute(
    (prefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
        .map((item) => item.textContent?.replace(/ /g, " ") ?? "")
        .join("\n"),
    testId(TID_TASK_ITEM, ""),
  );
}

/** Full text of the session transcript (v4 timeline; asserts no legacy synthetic prompt copy remains). */
async function readTimelineText(): Promise<string> {
  return browser.execute((timelineTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
    return element?.textContent?.replace(/ /g, " ") ?? "";
  }, TID_V4_TIMELINE);
}

describe("直接启动 E2E", () => {
  before(async () => {
    await ensureZhCnLocale();
    await mkdir(WORKFLOWS_DIR, { recursive: true });
    await writeFile(LAUNCH_OK_FILE, LAUNCH_OK_SEED, "utf-8");
    await writeFile(LAUNCH_FAIL_FILE, LAUNCH_FAIL_SEED, "utf-8");
    await writeFile(LAUNCH_MODEL_FILE, LAUNCH_MODEL_SEED, "utf-8");
    await writeFile(LAUNCH_SLEEP_FILE, LAUNCH_SLEEP_SEED, "utf-8");
    await writeFile(LAUNCH_SAVE_FILE, LAUNCH_SAVE_SEED, "utf-8");
    await writeFile(LAUNCH_ARTIFACT_FILE, LAUNCH_ARTIFACT_SEED, "utf-8");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(WORKFLOWS_DIR, { recursive: true, force: true });
    await clearAppData();
  });

  it("中枢「运行」常量工作流：新会话顶部启动卡跑到 completed，无用户气泡、无确认窗", async function () {
    this.timeout(180000);

    // Only login + workspace readiness are needed; the constant workflow never touches the provider (see the group comment).
    await prepareConversationE2E({ skipProvider: true });

    // 1) Automations page → "Workflows" tab → the constant workflow's card.
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    const okCardTestId = testId(TID_WORKFLOW_CARD, LAUNCH_OK_NAME);
    await waitForTestIdByDom(okCardTestId, {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现常量工作流卡片",
    });

    // 2) Click the card's "Run" → the project file with args pops the args dialog: header = name + scope badge, plus
    //    the "new session" note.
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_OK_NAME), {
      timeoutMsg: "常量工作流卡片没有「运行」按钮",
    });
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeout: 15000,
      timeoutMsg: "点「运行」后没有弹出实参窗",
    });
    const dialogText = (await readTestIdPrefixText(TID_WORKFLOW_LAUNCH_DIALOG)) ?? "";
    expect(dialogText).toContain(LAUNCH_OK_NAME); // 名字（mono）
    expect(dialogText).toContain("项目"); // 作用域徽标（scope.project）
    expect(dialogText).toContain("的新会话中运行"); // 「将立即在 X 的新会话中运行」说明

    // 3) Fill the arg and submit. Note the task count before submitting; the new session should add one more shortly.
    const tasksBeforeLaunch = await countTaskItems();
    await setInputValueByTestIdDom(
      testId(TID_WORKFLOW_LAUNCH_ARG, LAUNCH_OK_ARG),
      LAUNCH_OK_ARG_VALUE,
      {
        timeoutMsg: "实参窗没有出现 topic 输入框",
      },
    );
    await clickTestIdByDom(TID_WORKFLOW_LAUNCH_SUBMIT, {
      timeoutMsg: "实参窗没有「运行」提交按钮",
    });

    // 4) The app switches to the new session, and a run card grows at the top of the transcript (not a user bubble, not
    //    a CreateWorkflow tool row), carrying the workflow name; the arg value is not on the card but in the run details
    //    side pane's provenance section.
    const launchCardPrefix = testId(TID_CHAT_WORKFLOW_RUN_DIGEST, "");
    await browser.waitUntil(
      async () =>
        (await readLaunchCardStatus()) !== null ||
        Boolean(await readTestIdPrefixText(launchCardPrefix)),
      {
        timeout: 60000,
        timeoutMsg: "新会话顶部没有出现 run 卡",
      },
    );
    const cardText = (await readTestIdPrefixText(launchCardPrefix)) ?? "";
    expect(cardText).toContain(LAUNCH_OK_NAME);
    expect(cardText).not.toContain(LAUNCH_OK_ARG_VALUE);

    // 4b) The card's ⤢ opens the run details side pane: the provenance section says "launched by you from the workflows
    //     hub", plus the scope and the arg value just entered.
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await browser.waitUntil(async () => (await readLaunchProvenanceText()) !== null, {
      timeout: 30000,
      timeoutMsg: "run 详情侧板没有出现来龙去脉节",
    });
    const provenanceText = (await readLaunchProvenanceText()) ?? "";
    expect(provenanceText).toContain(LAUNCH_OK_ARG_VALUE);

    // 5) No user bubble, no legacy synthetic prompt copy: the transcript must not contain composer copy such as
    //    "Run the saved workflow" that this spec removed.
    expect(await readTimelineText()).not.toContain("Run the saved workflow");

    // 6) No confirmation dialog: direct launch is a documented confirmation bypass, so the generic confirm dialog must not appear.
    const hasConfirmDialog = await browser.execute(
      (confirmTestId) => Boolean(document.querySelector(`[data-testid="${confirmTestId}"]`)),
      TID_CONFIRM_DIALOG_CONFIRM,
    );
    expect(hasConfirmDialog).toBe(false);

    // 7) The run card's status reaches completed (the constant workflow has zero agents and settles immediately). Wide
    //    timeout: run-started → run-settled goes through the real dwf runtime subprocess.
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });

    // 8) The sidebar session title = the workflow name (titleSource: first_input — no full message, no LLM wait);
    //    and a new session was indeed created.
    await browser.waitUntil(async () => (await countTaskItems()) === tasksBeforeLaunch + 1, {
      timeout: 20000,
      timeoutMsg: "直接启动后没有新增一个会话",
    });
    expect(await readTaskItemsText()).toContain(LAUNCH_OK_NAME);
  });

  it("编译失败的工作流：实参窗行内错误显示 compile_failed，会话列表不新增", async function () {
    this.timeout(150000);

    await prepareConversationE2E({ skipProvider: true });

    // 1) Automations page → "Workflows" tab → the broken-workflow card (frontmatter is legal, so the card appears).
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    const failCardTestId = testId(TID_WORKFLOW_CARD, LAUNCH_FAIL_NAME);
    await waitForTestIdByDom(failCardTestId, {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现编译失败工作流卡片",
    });

    // 2) "Run" → args dialog → fill the arg and submit. Note the task count before submitting.
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_FAIL_NAME), {
      timeoutMsg: "编译失败工作流卡片没有「运行」按钮",
    });
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeout: 15000,
      timeoutMsg: "点「运行」后没有弹出实参窗",
    });
    const tasksBeforeReject = await countTaskItems();
    await setInputValueByTestIdDom(testId(TID_WORKFLOW_LAUNCH_ARG, LAUNCH_OK_ARG), "x", {
      timeoutMsg: "实参窗没有出现 topic 输入框",
    });
    await clickTestIdByDom(TID_WORKFLOW_LAUNCH_SUBMIT, {
      timeoutMsg: "实参窗没有「运行」提交按钮",
    });

    // 3) The inline error area appears, titled with the compile_failed copy; the args dialog stays (no navigation, no session).
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_ERROR, {
      timeout: 30000,
      timeoutMsg: "编译失败没有在实参窗行内错误区显示",
    });
    const errorText = (await readTestIdPrefixText(TID_WORKFLOW_LAUNCH_ERROR)) ?? "";
    expect(errorText).toContain("工作流脚本编译失败");
    // The args dialog is still up (failure does not close it).
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeoutMsg: "编译失败后实参窗被意外关闭",
    });

    // 4) The session list gains nothing: the agent side creates no row before stages ① ② fail, and the GUI side
    //    immediately calls deleteSession to reclaim the just-created empty session (invariant 2).
    await browser.waitUntil(async () => (await countTaskItems()) === tasksBeforeReject, {
      timeout: 15000,
      timeoutMsg: "编译失败却新增了一个会话",
    });
  });

  it("脚本点名的模型解不出来：实参窗行内显示 compile_failed 与那个名字的 9011，会话列表不新增", async function () {
    this.timeout(150000);

    await prepareConversationE2E({ skipProvider: true });

    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_MODEL_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现点名未知模型的工作流卡片",
    });

    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_MODEL_NAME), {
      timeoutMsg: "点名未知模型的工作流卡片没有「运行」按钮",
    });
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeout: 15000,
      timeoutMsg: "点「运行」后没有弹出实参窗",
    });
    const tasksBefore = await countTaskItems();
    await setInputValueByTestIdDom(testId(TID_WORKFLOW_LAUNCH_ARG, LAUNCH_OK_ARG), "x", {
      timeoutMsg: "实参窗没有出现 topic 输入框",
    });
    await clickTestIdByDom(TID_WORKFLOW_LAUNCH_SUBMIT, {
      timeoutMsg: "实参窗没有「运行」提交按钮",
    });

    // Same exit as a script that fails to compile: the title is the compile_failed copy, and the detail is a located
    // diagnostic. With a catalog the detail names the model; without one it says the host cannot choose models — both
    // fixes are on the script side.
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_ERROR, {
      timeout: 30000,
      timeoutMsg: "解不出来的模型没有在实参窗行内错误区显示",
    });
    const errorText = (await readTestIdPrefixText(TID_WORKFLOW_LAUNCH_ERROR)) ?? "";
    expect(errorText).toContain("工作流脚本编译失败");
    expect(errorText).toMatch(/L\d+:C\d+/);
    expect(
      errorText.includes(LAUNCH_MODEL_UNKNOWN) || errorText.includes("cannot choose models"),
    ).toBe(true);
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeoutMsg: "解不出来的模型让实参窗被意外关闭",
    });
    await browser.waitUntil(async () => (await countTaskItems()) === tasksBefore, {
      timeout: 15000,
      timeoutMsg: "解不出来的模型却新增了一个会话",
    });
  });

  // Composer badge direct-open (docs/dynamic-workflow/presentation.md, "Other places a run appears"): when the only
  // thing running in the session is a workflow, clicking the badge does not expand the status capsule; it opens that
  // run's details side tab directly.
  it("唯一在跑的工作流：composer 徽标直达详情 side tab，状态胶囊不展开", async function () {
    this.timeout(180000);

    await prepareConversationE2E({ skipProvider: true });

    // 1) Automations page → "Workflows" tab → the arg-less project file runs on "Run" (no args dialog, no confirm dialog).
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_SLEEP_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现停留 running 的常量工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_SLEEP_NAME), {
      timeoutMsg: "常量工作流卡片没有「运行」按钮",
    });

    // 2) A run card grows at the top of the new session and the run enters running (world.run's sleep parks it here).
    const launchCardPrefix = testId(TID_CHAT_WORKFLOW_RUN_DIGEST, "");
    await browser.waitUntil(async () => Boolean(await readTestIdPrefixText(launchCardPrefix)), {
      timeout: 60000,
      timeoutMsg: "新会话顶部没有出现 run 卡",
    });

    // 2b) Sidebar run line (docs/dynamic-workflow/presentation.md, "The sidebar run line"): the session row that launched
    //     it grows a running run line under its title; the sleep script has no phase() markers, so the rail is a single
    //     implicit station.
    await browser.waitUntil(
      async () =>
        browser.execute(
          (prefix) => {
            const rows = Array.from(
              document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`),
            );
            return rows.some((row) => {
              const line = row.querySelector<HTMLElement>(
                '[data-workflow-run-line][data-run-status="running"]',
              );
              return (
                line !== null &&
                line.querySelector('[data-workflow-run-rail][data-implicit="true"]') !== null
              );
            });
          },
          testId(TID_TASK_ITEM, ""),
        ),
      { timeout: 60000, timeoutMsg: "侧栏里发起工作流的会话行没有长出 running 的运行行" },
    );

    // 2c) Status capsule (docs/dynamic-workflow/presentation.md, "Other places a run appears"): the running workflow
    //     sorts first in the capsule and shows by name (name · lamp · word) instead of a count like "1 background".
    await browser.waitUntil(
      async () =>
        browser.execute((panelTestId) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          const pill = panel?.querySelector<HTMLElement>("[data-workflow-pill]");
          const button = pill?.closest("button");
          return (
            pill !== null &&
            pill !== undefined &&
            (pill.textContent ?? "").trim().length > 0 &&
            button?.querySelector('[data-workflow-run-lamp="running"]') !== null
          );
        }, TID_CHAT_SUMMARY_PANEL),
      { timeout: 30000, timeoutMsg: "状态胶囊没有按名字显示在跑的工作流" },
    );

    // 3) Composer badge: exactly one workflow, no terminals and no subagents, and its declared open target is workflow-run.
    await browser.waitUntil(
      async () => {
        const counts = await getV4ComposerBackgroundWorkCounts();
        return (
          counts?.workflowCount === 1 &&
          counts.bashCount === 0 &&
          counts.subagentCount === 0 &&
          counts.totalCount === 1 &&
          counts.openTarget === "workflow-run"
        );
      },
      { timeout: 60000, timeoutMsg: "composer 徽标没有以 workflow-run 落点显示唯一在跑的工作流" },
    );
    const panelModeBefore = await browser.execute(
      (panelTestId) =>
        document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`)?.dataset
          .displayMode ?? null,
      TID_CHAT_SUMMARY_PANEL,
    );
    expect(panelModeBefore).not.toBe("panel");

    // 4) Click the badge → the side pane shows that run's workflow-run tab (structured id prefix), and the capsule was
    //    not switched to panel mode.
    await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER, {
      timeoutMsg: "composer 后台任务入口不可点击",
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(document.querySelector('[data-side-pane-tab-id^="workflow-run:"]')),
        ),
      { timeout: 30000, timeoutMsg: "点徽标后侧板没有打开 workflow-run tab" },
    );
    const panelModeAfter = await browser.execute(
      (panelTestId) =>
        document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`)?.dataset
          .displayMode ?? null,
      TID_CHAT_SUMMARY_PANEL,
    );
    expect(panelModeAfter).not.toBe("panel");

    // 5) Click the capsule to expand: the "Workflows" section opens along with it, no separate section-header click
    //    needed — what you see expanded must not be less than what the capsule shows
    //    (docs/dynamic-workflow/presentation.md, "Other places a run appears"). The run row is a fixed two lines: name +
    //    elapsed on the first, lamp + word on the second (the sleep script has no phase() markers, so it is one running
    //    lamp + step count). Hovering the row overlays Stop on the elapsed time.
    await browser.execute((panelTestId) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      panel?.querySelector<HTMLElement>("[data-workflow-pill]")?.closest("button")?.click();
    }, TID_CHAT_SUMMARY_PANEL);
    const rowSelector = 'li[data-background-task-kind="workflow"]';
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const row = document.querySelector<HTMLElement>(selector);
          return (
            row?.querySelector('[data-workflow-island-line="name"] [data-workflow-run-elapsed]') !==
              null &&
            row?.querySelector(
              '[data-workflow-island-line="phase"] [data-workflow-run-lamp="running"]',
            ) !== null
          );
        }, rowSelector),
      {
        timeout: 15000,
        timeoutMsg: "点开胶囊后「工作流」分区没有直接显示 run 行（名字 + 时长 / 灯 + 词两行）",
      },
    );
    await $(rowSelector).moveTo();
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const stop = document.querySelector<HTMLElement>(
            `${selector} [data-testid^="v4-background-work-cancel-"]`,
          );
          return stop !== null && getComputedStyle(stop).opacity === "1";
        }, rowSelector),
      { timeout: 5000, timeoutMsg: "悬停 run 行时 Stop 没有出现" },
    );
  });

  // Concurrency chip (docs/dynamic-workflow/concurrency.md, "What the user sees"): the chip's number is a bound and its
  // label is "Max concurrency"; it comes and goes together with Configure — while the run is in flight, lowering the
  // bound in place makes the chip appear; once the run completes the chip leaves, rather than keeping a bound with
  // nothing running under it hung up as a live reading.
  it("并发芯片：在跑的 run 就地调小界后显示「最大并发数 N」，run 完成后芯片离开", async function () {
    this.timeout(180000);

    await prepareConversationE2E({ skipProvider: true });

    // 1) Run the constant workflow that stays running (world.run sleep 40s) and open its run side pane.
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_SLEEP_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现停留 running 的常量工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_SLEEP_NAME), {
      timeoutMsg: "常量工作流卡片没有「运行」按钮",
    });
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "running", {
      timeout: 60000,
      timeoutMsg: "run 卡没有进入 running",
    });
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await waitForTestIdByDom("workflow-run-configure", {
      timeout: 30000,
      timeoutMsg: "在跑的 run 侧板上没有 Configure",
    });

    // 2) Running at the default concurrency D (no bound of its own): no chip.
    expect(await readTestIdText("workflow-run-concurrency")).toBeNull();

    // 3) Configure → stepper minus one → apply: only the bound changes while the run is in flight, taking effect in
    //    place (no new run).
    await clickTestIdByDom("workflow-run-configure", { timeoutMsg: "Configure 不可点击" });
    await waitForTestIdByDom("workflow-run-settings-popover", {
      timeoutMsg: "点 Configure 后没有设置弹层",
    });
    // The stepper sits at the default concurrency D = max(4, min(16, cores − 2)), so minus one always has room to go lower.
    const defaultBound = Number(await readTestIdText("workflow-run-settings-bound-value"));
    // Not yet changed: no consequence sentence (before the change, either sentence could read wrong).
    expect(await readTestIdText("workflow-run-settings-consequence")).toBe("");
    await clickTestIdByDom("workflow-run-settings-bound-decrease", {
      timeoutMsg: "设置弹层没有「降低最大并发数」",
    });
    // Only the bound changed and the run is in flight: the consequence sentence is the "in-place" one, not "will stop the current run".
    expect(await readTestIdText("workflow-run-settings-consequence")).toMatch(
      /^(立即应用到当前运行，不会新起一次运行。|Applies to this run right away; no new run is started\.)$/,
    );
    await clickTestIdByDom("workflow-run-settings-apply", { timeoutMsg: "设置弹层没有「应用」" });

    // 4) The chip appears, with the bound's label and the lowered bound as its number.
    await browser.waitUntil(
      async () => {
        const text = await readTestIdText("workflow-run-concurrency");
        return (
          text !== null &&
          new RegExp(`^(最大并发数|Max concurrency) ${defaultBound - 1}\\b`).test(text)
        );
      },
      { timeout: 30000, timeoutMsg: "就地调小界后 run 侧板没有出现「最大并发数 N」芯片" },
    );

    // 5) The run finishes (sleep ends): Configure and the chip leave together.
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });
    await browser.waitUntil(
      async () =>
        (await readTestIdText("workflow-run-concurrency")) === null &&
        (await readTestIdText("workflow-run-configure")) === null,
      { timeout: 20000, timeoutMsg: "run 完成后侧板上仍有并发芯片或 Configure" },
    );
  });

  it("完成的 run：侧板有「已保存」与「再次运行」，芯片直达中枢；删掉后「保存」按原样写回同一份脚本", async function () {
    this.timeout(240000);

    await prepareConversationE2E({ skipProvider: true });

    // 1) Hub "Run" on the arg-less project file: runs on click, and the run card at the top of the new session reaches completed.
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_SAVE_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现保存用例的工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_SAVE_NAME), {
      timeoutMsg: "保存用例的工作流卡片没有「运行」按钮",
    });
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });

    // 2) ⤢ opens the run side pane: a run launched from the hub is naturally "Saved" by the name rule — the chip sits in
    //    the status line and the verb is "Run again".
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await waitForTestIdByDom("workflow-saved-chip", {
      timeout: 30000,
      timeoutMsg: "run 侧板状态行没有出现「已保存」芯片",
    });
    await waitForTestIdByDom("workflow-save-run-again", {
      timeout: 10000,
      timeoutMsg: "run 侧板没有「再次运行」",
    });

    // 3) The chip deep-links into that workflow's detail page in the hub.
    await clickTestIdByDom("workflow-saved-chip", { timeoutMsg: "「已保存」芯片不可点击" });
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL, {
      timeout: 20000,
      timeoutMsg: "点芯片后没有进入工作流详情页",
    });
    expect((await readTestIdText(TID_WORKFLOW_DETAIL)) ?? "").toContain(LAUNCH_SAVE_NAME);

    // 4) Delete it in the hub: the hub refresh invalidates the card's read cache, so this run is no longer "Saved".
    await clickTestIdByWebDriver(TID_WORKFLOW_DETAIL_MENU, {
      timeoutMsg: "详情页没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_DELETE, LAUNCH_SAVE_NAME), {
      timeoutMsg: "详情页菜单没有「删除工作流」项",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeoutMsg: "删除二次确认弹窗没有出现",
    });
    await browser.waitUntil(async () => !(await fileExists(LAUNCH_SAVE_FILE)), {
      timeout: 10000,
      timeoutMsg: "删除后磁盘文件仍然存在",
    });

    // 5) Back in the launching session, the side pane's verb flips back to "Save".
    const sessionTaskTestId = await browser.execute(
      (prefix, name) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)).find(
          (item) => item.textContent?.includes(name),
        )?.dataset.testid ?? null,
      testId(TID_TASK_ITEM, ""),
      LAUNCH_SAVE_NAME,
    );
    expect(sessionTaskTestId).not.toBeNull();
    await clickTestIdByDom(sessionTaskTestId!, { timeoutMsg: "侧栏里点不到发起它的会话" });
    await clickTestIdByDom("workflow-card-open-details", {
      timeout: 20000,
      timeoutMsg: "回到会话后 run 卡上没有「打开运行详情」",
    });
    await waitForTestIdByDom("workflow-save-open", {
      timeout: 30000,
      timeoutMsg: "删掉工作流之后 run 侧板没有翻回「保存」",
    });

    // 6) "Save" → popover → save directly as-is: no model turn involved; what gets written is the exact script this run executed.
    await clickTestIdByDom("workflow-save-open", { timeoutMsg: "「保存」不可点击" });
    await waitForTestIdByDom("workflow-save-popover", { timeoutMsg: "点「保存」后没有弹层" });
    await setInputValueByTestIdDom("workflow-save-name", LAUNCH_SAVE_NAME, {
      timeoutMsg: "保存弹层没有名称输入框",
    });
    await clickTestIdByDom("workflow-save-submit", { timeoutMsg: "保存弹层没有「直接保存」" });
    await browser.waitUntil(async () => fileExists(LAUNCH_SAVE_FILE), {
      timeout: 20000,
      timeoutMsg: "直接保存后磁盘上没有出现工作流文件",
    });
    const written = await readFile(LAUNCH_SAVE_FILE, "utf-8");
    expect(written.startsWith("/* zcode-workflow")).toBe(true);
    expect(written.endsWith(`*/\n${LAUNCH_SAVE_SCRIPT}`)).toBe(true);

    // 7) The card flips immediately: the chip returns and the verb is "Run again" again.
    await waitForTestIdByDom("workflow-saved-chip", {
      timeout: 20000,
      timeoutMsg: "直接保存后 run 侧板没有出现「已保存」芯片",
    });
    await waitForTestIdByDom("workflow-save-run-again", {
      timeout: 10000,
      timeoutMsg: "直接保存后 run 侧板没有翻成「再次运行」",
    });
  });

  it("产物 tab「作为文件打开」：把这一版的 markdown 落成本机副本，交给系统默认 App", async function () {
    this.timeout(240000);

    await prepareConversationE2E({ skipProvider: true });

    // 1) Hub "Run" on the arg-less project file: runs on click, the run publishes a markdown artifact, then completes.
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_ARTIFACT_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现产物用例的工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_ARTIFACT_NAME), {
      timeoutMsg: "产物用例的工作流卡片没有「运行」按钮",
    });
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });

    // 2) ⤢ opens the run side pane → the only artifact is the primary artifact row → artifact tab, whose body is markdown.
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await clickTestIdByDom(TID_WORKFLOW_ARTIFACT_CARD, {
      timeout: 30000,
      timeoutMsg: "run 侧板没有出现产物行",
    });
    await waitForTestIdByDom(TID_WORKFLOW_ARTIFACT_PANE, {
      timeout: 20000,
      timeoutMsg: "点产物行后没有打开产物 tab",
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() => Boolean(document.querySelector('[data-artifact-body="markdown"]'))),
      { timeout: 20000, timeoutMsg: "产物 tab 没有画出 markdown 正文" },
    );

    // 3) Click "Open as file": main writes the copy, then hands it to the system default app via shell.openPath
    //    (caught by the mock here).
    const openPath = await browser.electron.mock("shell", "openPath");
    await openPath.mockResolvedValue("");
    try {
      const readOpenedPaths = async (): Promise<string[]> => {
        await openPath.update();
        return openPath.mock.calls.map(([path]) => String(path));
      };
      await clickTestIdByDom("workflow-artifact-open-as-file", {
        timeoutMsg: "产物 tab 头部没有「作为文件打开」",
      });
      await browser.waitUntil(async () => (await readOpenedPaths()).length === 1, {
        timeout: 15000,
        timeoutMsg: "「作为文件打开」没有经 shell.openPath 打开文件",
      });
      const [openedPath] = await readOpenedPaths();
      expect(openedPath).toContain(join("tmp", "workflow-artifacts"));
      expect(openedPath!.endsWith(join("v1", `${LAUNCH_ARTIFACT_ID}.md`))).toBe(true);
      expect(await readFile(openedPath!, "utf-8")).toBe(LAUNCH_ARTIFACT_MARKDOWN);

      // 4) Click again: the same version opens the same copy.
      await clickTestIdByDom("workflow-artifact-open-as-file", {
        timeoutMsg: "产物 tab 头部没有「作为文件打开」",
      });
      await browser.waitUntil(async () => (await readOpenedPaths()).length === 2, {
        timeout: 15000,
        timeoutMsg: "第二次「作为文件打开」没有打开文件",
      });
      expect((await readOpenedPaths())[1]).toBe(openedPath);
    } finally {
      await browser.electron.restoreAllMocks();
    }
  });
});
