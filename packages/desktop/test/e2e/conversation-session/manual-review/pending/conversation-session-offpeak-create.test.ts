import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  modelSelectionSchema,
  OFF_PEAK_PROVIDER_IDS,
  type ModelSelection,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_SESSION,
  TID_OFFPEAK_CREATE_CARD,
  TID_OFFPEAK_CREATE_OPEN,
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_EDIT_VIEW,
  TID_OFFPEAK_FORM_TITLE,
  TID_OFFPEAK_TAB,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import {
  expandAssistantHistoriesWithContent,
  getToolCallDiagnostics,
} from "../../../helpers/conversation-session-tool-diagnostics.js";
import {
  getUpstreamRequestToolContract,
  waitForUpstreamRequest,
} from "../../../helpers/conversation-session-network.js";
import {
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  startElectronWindowRecording,
} from "../../../helpers/electron-window-recorder.js";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

// Aligned with fixtures/upstream/conversation-session/conversation-session-offpeak-create.json:
// the marker in the prompt triggers the replayed OffPeakCreate tool call; title is the fixed idle-task title in the
// tool arguments.
const CASE_NAME = "conversation-session-offpeak-create";
const MARKER = "E2E_OFFPEAK_CHAT_CREATE";
const TASK_TITLE = "E2E_OFFPEAK_DIGEST";
const UPDATED_TASK_TITLE = "E2E_OFFPEAK_DIGEST_EDITED";
// wdio.conf startOffPeakE2EMock: a spec name containing offpeak → ZCODE_OFFPEAK_MOCK=1,
// isolating the Built-in single-model whitelist to GLM-5.2; the ticket stays queued within 60s, in position 1.
const MOCK_ALLOWED_MODEL = "GLM-5.2";

/**
 * D49 end-to-end core experience of creating an idle-time task inside a session:
 * prompt → OffPeakCreate enters the provider tool surface → approval → end-of-turn card (title + queue-position
 * snapshot) → storage defaults (yolo / last in whitelist / top reasoning tier) → click "去到闲时任务" to jump
 * straight to the edit form → change the title and save → the list shows it back.
 *
 * Model responses go through upstream replay; ticketing goes through the in-process mock gateway; creation and edit
 * really hit storage — deterministic.
 */
describe("会话内 OffPeakCreate 闲时任务卡片与直达编辑 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OP-CHAT-01: prompt 创建闲时任务 → 轮尾卡 → 直达编辑表单修改", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    const recording = await startElectronWindowRecording({
      frameIntervalMs: 200,
      outputPath: resolveArtifactPath(`${CASE_NAME}.webm`),
    });

    try {
      // 1) The user asks in natural language to run during idle time; the marker hits the fixture's fixed
      // OffPeakCreate tool_use response.
      await sendV4Prompt(
        `${MARKER} 帮我建一个闲时任务：整理今天改动的文件并生成一份摘要写到 DIGEST.md`,
      );
      await waitForV4TimelineContaining(MARKER);

      // 2) Regression boundary: the OffPeakCreate contract must really enter the provider request (the tool surface
      // is already gated down per D49-8).
      const createRequest = { lastUserMessageIncludes: [MARKER] };
      await waitForUpstreamRequest(
        createRequest,
        "没有捕获到会话内 OffPeakCreate 的 provider 请求",
      );
      const contract = await getUpstreamRequestToolContract(createRequest, "OffPeakCreate");
      expect(contract).not.toBeNull();
      const serializedContract = JSON.stringify(contract);
      expect(serializedContract).toContain("OffPeakCreate has no clock");
      expect(serializedContract).toContain("full-automatic mode");

      // 3) needsApproval: the approval parks at the composer dock; only after explicit approval does the tool really
      // take a ticket and persist.
      await approveV4Permission();
      const donePane = await waitForV4Pane(
        (snapshot) =>
          snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
        "会话内 OffPeakCreate 没有完成",
        90000,
      );
      const creatingSessionId = donePane.sessionId!;

      // 4) End-of-turn card: the moon card shows the task title + the queue-position snapshot at creation.
      await expandAssistantHistoriesWithContent();
      try {
        await waitForTestIdByDom(TID_OFFPEAK_CREATE_CARD, {
          timeout: 15000,
          timeoutMsg: "会话内没有渲染 OffPeakCreate 闲时任务卡片",
        });
      } catch (error) {
        const diagnostics = await getToolCallDiagnostics({
          type: "toolName",
          value: "OffPeakCreate",
        });
        throw new Error(
          `会话内没有渲染 OffPeakCreate 闲时任务卡片；diagnostics=${JSON.stringify(diagnostics)}`,
          { cause: error },
        );
      }
      await browser.waitUntil(
        async () => {
          const cardText = await readTestIdText(TID_OFFPEAK_CREATE_CARD);
          return cardText.includes(TASK_TITLE) && /in queue|排队第/u.test(cardText);
        },
        {
          timeout: 10000,
          timeoutMsg: "OffPeakCreate 卡片没有展示任务标题与位次快照",
        },
      );

      // Acceptance recording: let the card stay visible on screen for a discernible duration (does not affect
      // assertions).
      await browser.pause(1500);

      // 5) Storage defaults (D49-4): yolo / last model in the whitelist / non-empty reasoning tier; status queued.
      const created = await waitForOffPeakRecordByTitle(TASK_TITLE);
      expect(created.permissionMode).toBe("yolo");
      expect(created.modelSelection.modelId).toBe(MOCK_ALLOWED_MODEL);
      expect(Object.values(OFF_PEAK_PROVIDER_IDS)).toContain(created.modelSelection.providerId);
      expect(created.modelSelection.options?.reasoningLevel).toEqual(expect.any(String));
      expect(created.status).toBe("queued");
      // D50: in-session creation binds the current session (session_id is the creating session); conversation_id is
      // left empty for the first run to backfill.
      expect(created.sessionId).toBe(creatingSessionId);
      expect(created.conversationId).toBeNull();

      // 6) "去到闲时任务" → the Automations idle tab lands directly on that task's edit form.
      await clickTestIdByDom(TID_OFFPEAK_CREATE_OPEN, {
        timeoutMsg: "闲时卡片没有「去到闲时任务」按钮",
      });
      try {
        await waitForTestIdByDom(TID_OFFPEAK_EDIT_VIEW, {
          timeout: 15000,
          timeoutMsg: "点击卡片后没有进入闲时任务编辑视图",
        });
      } catch (error) {
        // Diagnostics: distinguish three failure shapes — "no navigation", "navigated to the list but not into
        // edit", "toast not found".
        const dom = await readDomDiagnostics();
        throw new Error(`点击卡片后没有进入闲时任务编辑视图；dom=${JSON.stringify(dom)}`, {
          cause: error,
        });
      }
      await browser.waitUntil(
        async () => (await readTestIdValue(TID_OFFPEAK_FORM_TITLE)) === TASK_TITLE,
        {
          timeout: 10000,
          timeoutMsg: "编辑表单没有回显会话内创建的任务标题",
        },
      );

      await browser.pause(1500);

      // 7) queued is editable: change the title and save, the list echoes the new title, storage syncs.
      await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, UPDATED_TASK_TITLE, {
        timeoutMsg: "闲时任务标题输入不可编辑",
      });
      await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, {
        timeoutMsg: "闲时任务保存按钮不可点击",
      });
      await ensureIdleTabSelected();
      await browser.waitUntil(
        async () =>
          (await readAllTestIdTexts(TID_OFFPEAK_CARD)).some((t) => t.includes(UPDATED_TASK_TITLE)),
        {
          timeout: 20000,
          timeoutMsg: `闲时任务列表没有回显修改后的标题：${UPDATED_TASK_TITLE}`,
        },
      );
      const updated = await waitForOffPeakRecordByTitle(UPDATED_TASK_TITLE);
      expect(updated.offPeakTaskId).toBe(created.offPeakTaskId);
      // D50: the idle card footer shows the bound session's current title (the list joins against tasks-index).
      const boundSessionTitle = readTaskTitleById(creatingSessionId);
      expect(boundSessionTitle).toBeTruthy();
      await browser.waitUntil(
        async () =>
          (await readAllTestIdTexts(TID_OFFPEAK_CARD_SESSION)).some((t) =>
            t.includes(boundSessionTitle!),
          ),
        {
          timeout: 10000,
          timeoutMsg: `闲时卡片没有展示绑定会话标题：${boundSessionTitle}`,
        },
      );
      // Let the recording tail rest on the list echo screen, so the final state is legible during acceptance review.
      await browser.pause(1500);
    } finally {
      const result = await recording.stop({ tailDurationMs: 500 });
      await writeRecordingManifest({ frameCount: result.frameCount, videoPath: result.videoPath });
    }
  });
});

interface OffPeakRecord {
  offPeakTaskId: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  status: string;
  sessionId: string | null;
  conversationId: string | null;
}

function readTaskTitleById(taskId: string): string | null {
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "v2", "tasks-index.sqlite"),
    { readOnly: true },
  );
  try {
    const row = database.prepare(`SELECT title FROM tasks WHERE task_id = ?`).get(taskId) as
      | { title: string }
      | undefined;
    return row?.title?.trim() || null;
  } finally {
    database.close();
  }
}

async function waitForOffPeakRecordByTitle(title: string): Promise<OffPeakRecord> {
  let record: OffPeakRecord | null = null;
  await browser.waitUntil(
    async () => {
      record = readOffPeakRecordByTitle(title);
      return record !== null;
    },
    { timeout: 10000, timeoutMsg: `没有在 off_peak_tasks 中找到 ${title}` },
  );
  if (!record) throw new Error(`off_peak_tasks 记录为空：${title}`);
  return record;
}

function readOffPeakRecordByTitle(title: string): OffPeakRecord | null {
  // off_peak_tasks shares the database with tasks; E2E does one read-only row query per call and closes immediately.
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "v2", "tasks-index.sqlite"),
    { readOnly: true },
  );
  try {
    const hasTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasTable) return null;
    const row = database
      .prepare(
        `SELECT off_peak_task_id, permission_mode, model_selection, status, session_id, conversation_id
         FROM off_peak_tasks WHERE title = ?`,
      )
      .get(title) as
      | {
          off_peak_task_id: string;
          permission_mode: string;
          model_selection: string;
          status: string;
          session_id: string | null;
          conversation_id: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      offPeakTaskId: row.off_peak_task_id,
      permissionMode: row.permission_mode,
      modelSelection: modelSelectionSchema.parse(JSON.parse(row.model_selection)),
      status: row.status,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
    };
  } finally {
    database.close();
  }
}

/** After saving, if back on the list's default tab, switch to the idle-task tab; when already on the idle tab the button may not exist — ignore. */
async function ensureIdleTabSelected(): Promise<void> {
  try {
    await clickTestIdByDom(TID_OFFPEAK_TAB, { timeout: 5000, timeoutMsg: "" });
  } catch {
    // Already on the idle tab, or the tab bar is not rendered; the later list assertions will give the real failure
    // reason.
  }
}

async function readDomDiagnostics(): Promise<{
  testIds: string[];
  toasts: string[];
  bodyText: string;
}> {
  return browser.execute(() => {
    const testIds = Array.from(
      new Set(
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((el) => el.dataset.testid ?? "")
          .filter((id) => /offpeak|automation|settings|toast/iu.test(id)),
      ),
    );
    const toasts = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="status"],[data-sonner-toast],[data-radix-toast-viewport] *',
      ),
    )
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean)
      .slice(0, 5);
    return { testIds, toasts, bodyText: (document.body.innerText ?? "").slice(0, 1500) };
  });
}

async function readTestIdText(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid,
    );
    return el?.textContent?.trim() ?? "";
  }, currentTestId);
}

async function readAllTestIdTexts(currentTestId: string): Promise<string[]> {
  return browser.execute((tid) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .filter((item) => item.dataset.testid === tid)
      .map((item) => item.textContent?.trim() ?? "");
  }, currentTestId);
}

async function readTestIdValue(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${tid}"]`,
    );
    return element?.value ?? "";
  }, currentTestId);
}

function resolveArtifactPath(fileName: string) {
  return resolve(
    process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() ||
      process.env.CODEX_E2E_ARTIFACT_DIR?.trim() ||
      join(process.cwd(), ".e2e-artifacts", CASE_NAME),
    fileName,
  );
}

async function writeRecordingManifest(input: { frameCount: number; videoPath: string }) {
  const manifestPath = resolveArtifactPath(`${CASE_NAME}.recording.json`);
  await mkdir(resolve(manifestPath, ".."), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        case: CASE_NAME,
        video_capture_mode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
        video_path: input.videoPath,
        frame_count: input.frameCount,
        recorded_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
