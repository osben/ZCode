import { readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_MEMORY_SWITCH,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
  TID_V4_BACKGROUND_WORK_CANCEL,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readSettings,
  seedCliConfig,
} from "../../../helpers/desktop-app.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

// MEM13/MEM14. Explicit case-local replay holds the Dream provider response, not the UI thread.
// Promotion requires human review; this case deliberately stays in manual-review/pending.
describe("manual Dream background progress", () => {
  before(async function () {
    this.timeout(120_000);
    await seedCliConfig({ features: { memory: true }, memory: { use: true } });
    await prepareV4ConversationE2E();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "memory"));
    if (!(await readSettings()).memoryEnabled) await clickTestIdByDom(TID_SETTINGS_MEMORY_SWITCH);
    await browser.waitUntil(async () => (await readSettings()).memoryEnabled === true, {
      timeout: 15_000,
      timeoutMsg: "Memory setting did not persist",
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await sendV4Prompt("E2E_DREAM_HISTORY");
    await waitForV4TimelineContaining("E2E_DREAM_HISTORY_DONE");
    historySession = (await getV4PaneSnapshot()).sessionId!;
    await startNewV4Draft();
    await sendV4Prompt("E2E_DREAM_CURRENT");
    await waitForV4TimelineContaining("E2E_DREAM_CURRENT_DONE");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  let historySession: string;

  it("shows progress, accepts a concurrent answer and retains the result", async function () {
    this.timeout(150_000);
    await sendV4Prompt("/dream");
    await waitForV4TimelineContaining("Dream started in background");
    await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
    await waitForDreamStatus("running");
    await browser.saveScreenshot(join(process.cwd(), ".e2e-artifacts", "dream-running.png"));
    await sendV4Prompt("E2E_DREAM_PARALLEL");
    await waitForV4TimelineContaining("E2E_DREAM_PARALLEL_DONE", 30_000);
    expect((await readDreamRow())?.status).toBe("running");
    await waitForDreamStatus("resultPending", 90_000);
    expect((await readDreamRow())?.text).toContain("E2E_DREAM_SUMMARY");
    expect((await readDreamRow())?.canCancel).toBe(false);
    const badge = await browser.$(`[data-testid="${TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}"]`);
    expect(await badge.getAttribute("data-background-total-count")).toBe("0");
    const transcript = await transcriptPath((await getV4PaneSnapshot()).sessionId!);
    const records = (await readFile(transcript, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { querySource?: string });
    expect(records.some((record) => record.querySource === "project_memory_dream")).toBe(true);
    const db = new DatabaseSync(join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"), {
      readOnly: true,
    });
    try {
      const facts = db
        .prepare(
          "select status, input_tokens, output_tokens, duration_ms from model_usage where session_id = ? and query_source = 'dream'",
        )
        .all((await getV4PaneSnapshot()).sessionId!);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(
        facts.every((fact) => fact.status === "completed" && Number(fact.duration_ms) >= 0),
      ).toBe(true);
      expect(
        facts.reduce(
          (sum, fact) => sum + Number(fact.input_tokens) + Number(fact.output_tokens),
          0,
        ),
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    await browser.saveScreenshot(join(process.cwd(), ".e2e-artifacts", "dream-completed.png"));
  });

  it("cancels through the panel and replaces the previous result", async function () {
    this.timeout(90_000);
    // Arrange fresh activity in this case's own historical transcript, since the current session
    // is intentionally excluded from the Dream corpus.
    const historicalTranscript = await transcriptPath(historySession);
    const now = new Date();
    await utimes(historicalTranscript, now, now);
    await sendV4Prompt("/dream");
    await waitForDreamStatus("running");
    const row = await readDreamRow();
    expect(row?.canCancel).toBe(true);
    await clickTestIdByDom(testId(TID_V4_BACKGROUND_WORK_CANCEL, row!.id));
    await waitForDreamStatus("cancelled");
    expect((await readDreamRow())?.canCancel).toBe(false);
    await browser.saveScreenshot(join(process.cwd(), ".e2e-artifacts", "dream-cancelled.png"));
  });
});

function readDreamRow() {
  return browser.execute(() => {
    const row = document.querySelector<HTMLElement>('[data-background-task-kind="dream"]');
    return row
      ? {
          id: row.dataset.backgroundTaskId!,
          status: row.dataset.status,
          text: row.textContent ?? "",
          canCancel: Boolean(row.querySelector("button")),
        }
      : null;
  });
}

async function waitForDreamStatus(status: string, timeout = 30_000) {
  await browser.waitUntil(async () => (await readDreamRow())?.status === status, {
    timeout,
    timeoutMsg: `Dream panel did not reach ${status}`,
  });
}

async function transcriptPath(sessionId: string): Promise<string> {
  for (const directory of ["debug", "rollout"]) {
    const path = join(
      getE2EAppDataPaths().storageRoot,
      "cli",
      directory,
      `model-io-${sessionId}.jsonl`,
    );
    try {
      await stat(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Missing model-io for test session ${sessionId}`);
}
