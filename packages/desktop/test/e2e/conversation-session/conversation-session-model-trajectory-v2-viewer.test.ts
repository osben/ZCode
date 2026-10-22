import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_MODEL_TRAJECTORY_V2_REFRESH,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_VIEW_MODEL_TRAJECTORY,
  TID_TASK_VIEW_MODEL_TRAJECTORY_V2,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
} from "../helpers/desktop-app.js";
import { ensureToolCrossProductFullAccessMode } from "../helpers/conversation-session-tool-cross-product.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const paths = getE2EAppDataPaths();
const CASE_ROOT = join(DEFAULT_WORKSPACE, "trv2-e2e");
const TARGET_PATH = join(CASE_ROOT, "target.txt");
const TARGET_RELATIVE_PATH = "trv2-e2e/target.txt";
const BASH_COMMAND = `cat ${TARGET_RELATIVE_PATH}`;

const TASK1_MARKER = "E2E_TRV01_TASK_SEED";
const TASK1_READY = "E2E_TRV01_TASK_READY";
const TASK1_TOOL_OUTPUT = "E2E_TRV01_TOOL_OUTPUT";
const TASK1_REASONING = "E2E_TRV01_REASONING";
const TASK2_MARKER = "E2E_TRV02_TASK_SEED";
const TASK2_READY = "E2E_TRV02_TASK_READY";

const GLOB_DESCRIPTION = "E2E_TRV02_GLOB_DESC";
const LEGACY_MODEL = { providerId: "e2e-provider", modelId: "e2e-trajectory-model" };
// Seeded records sit before the live turn; the bulk spread stays far under the 200-record window.
const SEED_HEADROOM_MS = 31 * 60_000;
const SEED_SPACING_MS = 10_000;
const SEED_DURATION_MS = 8_000;
const BULK_COUNT = 150;

type ActualTrajectoryRecord = {
  type?: string;
  sessionId?: string;
  requestId?: string;
  startedAt?: string;
  model?: { providerId?: string; modelId?: string };
  timing?: { stream?: boolean; timeToFirstContentMs?: number };
  response?: {
    text?: string;
    reasoningText?: string;
    toolCalls?: Array<{ name?: string }>;
  };
};

describe("模型调用轨迹 v2 查看器 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(CASE_ROOT, { recursive: true, force: true });
    await clearAppData();
  });

  it("TRV01+TRV06: 真实 Bash 工具回合的 timing/tool_usage 投影、任务菜单与启动器往返", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();
    await setRendererLocale("en-US");
    // Full access keeps the read-only Bash call prompt-free, like the other tool E2E cases.
    await ensureToolCrossProductFullAccessMode();
    await mkdir(CASE_ROOT, { recursive: true });
    await writeFile(TARGET_PATH, `${TASK1_TOOL_OUTPUT}\n`, "utf8");

    await sendV4Prompt(
      [
        `${TASK1_MARKER}: Use the Bash tool with exactly this command: ${BASH_COMMAND}.`,
        `Then reply with exactly "${TASK1_READY}" and no other text.`,
      ].join(" "),
    );
    await waitForV4TimelineContaining(TASK1_READY, 90_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== null && snapshot.sessionId !== "draft",
      "trajectory v2 live case 没有建立真实 task/session",
      45_000,
    );
    const taskId = (await getV4PaneSnapshot()).sessionId as string;

    // TRV01: the runtime must persist TTFT on the live records (specs/model-io-stream-timing.md).
    // Wait for the final reply record, not just the first timed one: the turn writes several records.
    const live = await waitForActualTrajectory(
      taskId,
      (record) => record.response?.text === TASK1_READY,
    );
    const bashRecord = live.records.find((record) =>
      record.response?.toolCalls?.some((toolCall) => toolCall.name === "Bash"),
    );
    expect(bashRecord).toBeDefined();
    expect(typeof bashRecord?.timing?.timeToFirstContentMs).toBe("number");
    expect(bashRecord?.timing?.stream).toBe(true);
    expect(live.records.some((record) => record.response?.text === TASK1_READY)).toBe(true);
    expect(live.records.some((record) => record.response?.reasoningText === TASK1_REASONING)).toBe(
      true,
    );

    await openTrajectoryV2ThroughTaskMenu(taskId);
    await waitForV2State("ready", "v2 pane 没有进入 ready");

    const summaryItems = await v2SummaryItems();
    for (const key of ["calls", "tokens", "model-time", "tool-time"]) {
      expect(summaryItems).toContain(key);
    }
    // Tool timing comes from the live CLI session db, never shown as unavailable.
    expect(await v2ToolTimeSource()).toBe("session-db");

    const ledger = await v2LedgerSnapshot();
    for (const kind of ["user", "request", "assistant", "tool"]) {
      expect(ledger.kinds).toContain(kind);
    }
    const bashRowText = ledger.toolRows.find((text) => text.includes("Bash"));
    expect(bashRowText).toBeDefined();
    expect(bashRowText).toContain(BASH_COMMAND);
    expect(bashRowText).toContain(TASK1_TOOL_OUTPUT);

    // Tool row timing: scheduled and execution values from tool_usage, duration is a real value.
    await selectV2Row("tool:toolu_e2e_trv_bash");
    expect(await v2InspectorKind()).toBe("tool");
    await clickV2Tab("timing");
    let timing = await v2InspectorFields();
    expect(timing["Scheduled"]).toBeDefined();
    expect(timing["Scheduled"]).not.toBe("—");
    expect(timing["Duration"]).toBeDefined();
    expect(timing["Duration"]).not.toBe("—");
    expect(timing["Duration"]).toMatch(/ms|s/);

    // Request row timing: the live stream must show a TTFT, never the unknown placeholder.
    await selectV2Row("req:");
    expect(await v2InspectorKind()).toBe("request");
    await clickV2Tab("timing");
    timing = await v2InspectorFields();
    expect(timing["Time to first token"]).toBeDefined();
    expect(timing["Time to first token"]).not.toBe("—");

    // TRV06: closing the tab must keep v2 reachable; the launcher reopens it for the active task.
    await closeTrajectoryV2Tab(taskId);
    await browser.waitUntil(async () => !(await v2PaneExists()), {
      timeout: 10_000,
      timeoutMsg: "closed v2 tab did not unmount the pane",
    });
    if (await $("[data-side-pane-add-tab-trigger]").isExisting()) {
      await $("[data-side-pane-add-tab-trigger]").click();
    } else {
      await clickTestIdByDom(TID_SIDE_PANE_TOGGLE);
    }
    await $('[data-side-pane-open-tab-item="model-trajectory-v2"]').click();
    await waitForV2State("ready", "启动器重新打开 v2 后没有回到 ready");
    expect((await v2LedgerSnapshot()).kinds).toContain("tool");
  });

  it("TRV02-TRV05+TRV07: 请求差异、载荷、范围过滤、虚拟列表、刷新与窄布局", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();
    await setRendererLocale("en-US");
    await sendV4Prompt(`${TASK2_MARKER} reply with exactly ${TASK2_READY} and no other text.`);
    await waitForV4TimelineContaining(TASK2_READY, 90_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== null && snapshot.sessionId !== "draft",
      "trajectory v2 seeded case 没有建立真实 task/session",
      45_000,
    );
    const taskId = (await getV4PaneSnapshot()).sessionId as string;

    // Wait for the final reply record, not just the first timed one: the turn writes several records.
    const live = await waitForActualTrajectory(
      taskId,
      (record) => record.response?.text === TASK2_READY,
    );
    const liveModel =
      live.records.find((record) => record.response?.text === TASK2_READY)?.model ?? LEGACY_MODEL;
    expect(liveModel.modelId).toBeTruthy();
    const liveStartMs = Math.min(
      ...live.records
        .map((record) => Date.parse(record.startedAt ?? ""))
        .filter((time) => Number.isFinite(time)),
    );
    const baseMs = liveStartMs - SEED_HEADROOM_MS;

    await appendFile(
      live.filePath,
      `${buildSeedRecords(taskId, liveModel, baseMs)
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
      "utf8",
    );

    await openTrajectoryV2ThroughTaskMenu(taskId);
    await waitForV2State("ready", "seeded v2 pane 没有进入 ready");

    // TRV02-TRV05 run in the side-by-side layout: a narrow pane replaces the ledger with the inspector on selection.
    const sizeBeforeWide = await setCurrentElectronRendererContentSize(2400, 1000);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-trajectory-v2-layout]")].some(
            (element) => element.getAttribute("data-trajectory-v2-layout") === "split",
          ),
        ),
      {
        timeout: 10_000,
        timeoutMsg: "v2 pane did not switch to the split layout on a wide renderer",
      },
    );

    // TRV02: separator chips carry the request deltas between the two catalogs.
    const chips = await v2RowChangeChips("req:e2e-trv-r001:");
    expect(chips.map((chip) => chip.kind)).toEqual(
      expect.arrayContaining(["param", "tools", "system"]),
    );
    expect(chips.map((chip) => chip.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("effort high → low"),
        expect.stringContaining("tools +1"),
      ]),
    );

    // TRV02: Payload tab shows the interned catalog and cache breakpoints of the wire body.
    await selectV2Row("req:e2e-trv-r001:");
    await clickV2Tab("payload");
    expect(await v2CatalogNames()).toEqual(expect.arrayContaining(["Bash", "Read", "Glob"]));
    const payloadText = await v2PayloadText();
    expect(payloadText).toContain("system[0]");
    expect(payloadText).toContain("tools[1]");
    let fields = await v2InspectorFields();
    expect(fields["maxOutputTokens"]).toBe("200");
    expect(fields["effort"]).toBe("low");

    // TRV02: known model → context % in the Summary tab (window from the live provider registry).
    await selectV2Row("req:e2e-trv-r000:");
    await clickV2Tab("summary");
    fields = await v2InspectorFields();
    expect(fields["Context"]).toMatch(/%\s*\(/);
    expect(fields["Cache write"]).toBe("8,000");

    // TRV02: Schema tab shows the call-time definition from that record's catalog.
    await selectV2Row("tool:toolu_e2e_trv_glob_1");
    await clickV2Tab("schema");
    const schemaText = await v2SchemaText("Glob");
    expect(schemaText).toContain(GLOB_DESCRIPTION);
    expect(schemaText).toContain("query");

    // TRV02: legacy record without wire body or timing shows unknown values, plus toolNames fallback.
    await selectV2Row("req:e2e-trv-r003:");
    await clickV2Tab("timing");
    fields = await v2InspectorFields();
    expect(fields["Time to first token"]).toBe("—");
    await clickV2Tab("payload");
    expect(await v2CatalogNames()).toEqual(expect.arrayContaining(["Bash", "Read"]));
    await clickV2Tab("summary");
    fields = await v2InspectorFields();
    expect(fields["Context"]).toBe("—");

    // TRV02: compaction marker row and the compact context-chart marker; unknown window → tokens axis.
    expect(await v2MarkerTexts()).toContain("Context compacted");
    expect(await v2ContextChartMode()).toBe("tokens");
    expect(await v2HasContextMarker("compact")).toBe(true);

    // TRV03: dragging on the strip filters the ledger; clearing restores it.
    const fullRowCount = (await v2RowCount()) ?? 0;
    expect(fullRowCount).toBeGreaterThan(250);
    await dragOnStrip(0.05, 0.45);
    await browser.waitUntil(async () => (await v2RangeAttribute()) !== null, {
      timeout: 10_000,
      timeoutMsg: "拖拽后 strip 没有记录 data-trajectory-v2-range",
    });
    expect(await v2RangeAttribute()).toMatch(/^\d+-\d+$/);
    await browser.waitUntil(
      async () => {
        const filtered = (await v2RowCount()) ?? 0;
        return filtered > 0 && filtered < fullRowCount;
      },
      { timeout: 10_000, timeoutMsg: "范围过滤没有缩小 ledger 行数" },
    );

    // TRV03: clicking a span selects its row.
    await clickStripSpan("req:e2e-trv-r001:");
    await browser.waitUntil(
      async () => ((await v2SelectedKey()) ?? "").startsWith("req:e2e-trv-r001:"),
      { timeout: 10_000, timeoutMsg: "点击 span 没有选中对应的 request 行" },
    );

    // TRV03: the range survives a refresh (clamped to the unchanged extent).
    const filteredRowCount = (await v2RowCount()) ?? 0;
    await clickV2Refresh();
    await waitForV2State("ready", "带范围刷新后没有回到 ready");
    expect(await v2RangeAttribute()).toMatch(/^\d+-\d+$/);
    expect((await v2RowCount()) ?? 0).toBe(filteredRowCount);
    await clickFirstDisplayed('[data-trajectory-v2-clear-range=""]');
    await browser.waitUntil(async () => (await v2RangeAttribute()) === null, {
      timeout: 10_000,
      timeoutMsg: "清除范围后 range 属性没有移除",
    });
    await browser.waitUntil(async () => ((await v2RowCount()) ?? 0) === fullRowCount, {
      timeout: 10_000,
      timeoutMsg: "清除范围后 ledger 行数没有恢复",
    });

    // TRV04: 150+ calls stay virtualized while scrolling, and arrow keys move the selection.
    await browser.waitUntil(async () => (await v2LedgerSnapshot()).mountedRows < 80, {
      timeout: 10_000,
      timeoutMsg: "虚拟列表挂载行数超过阈值",
    });
    await scrollLedgerTo(0.5);
    await browser.pause(300);
    expect((await v2LedgerSnapshot()).mountedRows).toBeLessThan(80);
    // r000 sits at the top; scrolled to the middle it is outside the virtual window and not mounted.
    await scrollLedgerTo(0);
    await browser.pause(300);
    await selectV2Row("req:e2e-trv-r000:");
    const beforeStepKey = await v2SelectedKey();
    await focusLedger();
    await browser.keys("ArrowDown");
    await browser.waitUntil(async () => (await v2SelectedKey()) !== beforeStepKey, {
      timeout: 10_000,
      timeoutMsg: "ArrowDown 没有移动选中行",
    });
    expect(await v2SelectedRowMounted()).toBe(true);
    await browser.keys("ArrowUp");
    await browser.waitUntil(async () => (await v2SelectedKey()) === beforeStepKey, {
      timeout: 10_000,
      timeoutMsg: "ArrowUp 没有回到上一个选中行",
    });

    // TRV05: refresh keeps the pane mounted, shows refreshing, adds rows and keeps the selection.
    await installV2StateObserver();
    await selectV2Row("req:e2e-trv-r003:");
    const selectedKey = await v2SelectedKey();
    const rowCountBeforeRefresh = (await v2RowCount()) ?? 0;
    await appendFile(
      live.filePath,
      `${JSON.stringify(
        createBulkRecord(taskId, {
          index: BULK_COUNT + 4,
          offset: BULK_COUNT + 1,
          startedAtMs: liveStartMs - 5 * 60_000,
          requestId: "e2e-trv-refresh-append",
          userText: "E2E_TRV05_APPENDED",
          assistantText: "E2E_TRV05_ASSISTANT",
          full: true,
        }),
      )}\n`,
      "utf8",
    );
    await clickV2Refresh();
    await browser.waitUntil(async () => ((await v2RowCount()) ?? 0) > rowCountBeforeRefresh, {
      timeout: 15_000,
      timeoutMsg: "刷新后没有出现新增行",
    });
    await waitForV2State("ready", "TRV05 刷新后没有回到 ready");
    const refreshEvidence = await readV2StateObserver();
    expect(refreshEvidence.transitions).toContain("refreshing");
    expect(refreshEvidence.paneStillMounted).toBe(true);
    expect(await v2SelectedKey()).toBe(selectedKey);

    // TRV07: a narrow pane switches to the single-column drill-in layout without page scroll. The window stays at or
    // above 768px: below that the app is in the mobile compact viewport and the inspector becomes a bottom sheet.
    const sizeBeforeNarrow = await setCurrentElectronRendererContentSize(900, 720);
    await browser.waitUntil(async () => (await v2Layout()) === "drill-in", {
      timeout: 15_000,
      timeoutMsg: "窄视口没有切换为 drill-in 布局",
    });
    expect(await v2PageHorizontalOverflow()).toBe(false);
    await selectV2Row("req:e2e-trv-r000:");
    await browser.waitUntil(async () => Boolean(await v2DrillInExists()), {
      timeout: 10_000,
      timeoutMsg: "窄视口选中行后没有出现 drill-in inspector",
    });
    await clickFirstDisplayed("[data-trajectory-v2-drill-in] button");
    await browser.waitUntil(async () => !(await v2DrillInExists()), {
      timeout: 10_000,
      timeoutMsg: "Back 没有退回 ledger",
    });
    await restoreElectronRendererContentSize(sizeBeforeNarrow);
    await restoreElectronRendererContentSize(sizeBeforeWide);
  });
});

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function seedToolDef(name: string, description: string, withCacheControl = false) {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "E2E_TRV02_ARGUMENT" } },
      required: ["query"],
    },
    ...(withCacheControl ? { cache_control: { type: "ephemeral" } } : {}),
  };
}

/**
 * Deterministic seeded records (TRV02-TRV05): two wire bodies differing by one tool and
 * effort/max_tokens, a compact call, a legacy record without body or timing, and a bulk tail
 * for virtualization. Timestamps anchor before the live turn so the ordering is stable.
 */
function buildSeedRecords(
  taskId: string,
  liveModel: { providerId?: string; modelId?: string },
  baseMs: number,
) {
  const knownModel = {
    providerId: liveModel.providerId ?? "",
    modelId: liveModel.modelId ?? "",
  };
  const at = (index: number) => baseMs + index * SEED_SPACING_MS;
  const wireBodyA = {
    max_tokens: 100,
    thinking: { type: "enabled", budget_tokens: 64 },
    output_config: { effort: "high" },
    tool_choice: "auto",
    system: [{ type: "text", text: "E2E_TRV02_SYSTEM_A", cache_control: { type: "ephemeral" } }],
    tools: [
      seedToolDef("Bash", "E2E_TRV02_BASH_DESC"),
      seedToolDef("Read", "E2E_TRV02_READ_DESC", true),
    ],
    messages: [],
  };
  const wireBodyB = {
    max_tokens: 200,
    thinking: { type: "enabled", budget_tokens: 64 },
    output_config: { effort: "low" },
    tool_choice: "auto",
    system: [{ type: "text", text: "E2E_TRV02_SYSTEM_B", cache_control: { type: "ephemeral" } }],
    tools: [
      seedToolDef("Bash", "E2E_TRV02_BASH_DESC"),
      seedToolDef("Read", "E2E_TRV02_READ_DESC", true),
      seedToolDef("Glob", GLOB_DESCRIPTION),
    ],
    messages: [],
  };

  const record0 = {
    type: "model_io",
    sessionId: taskId,
    requestId: "e2e-trv-r000",
    querySource: "main_turn",
    turnId: "turn-e2e-trv-seed",
    startedAt: iso(at(0)),
    completedAt: iso(at(0) + SEED_DURATION_MS),
    durationMs: SEED_DURATION_MS,
    model: knownModel,
    timing: {
      stream: true,
      timeToFirstProviderEventMs: 100,
      timeToFirstContentMs: 420,
      timeToFirstTextMs: 500,
    },
    request: {
      messages: [{ role: "user", content: "E2E_TRV02_USER_0" }],
      toolNames: ["Bash", "Read"],
      body: wireBodyA,
    },
    response: {
      finishReason: "tool-calls",
      text: "E2E_TRV02_ASSISTANT_0",
      toolCalls: [
        { id: "toolu_e2e_trv_read_0", name: "Read", input: { file_path: "E2E_TRV02_TARGET" } },
      ],
      usage: {
        inputTokens: 40_000,
        outputTokens: 100,
        cacheReadTokens: 20_000,
        reasoningTokens: 64,
        cacheWriteTokens: 8_000,
      },
    },
  };

  const record1 = {
    type: "model_io",
    sessionId: taskId,
    requestId: "e2e-trv-r001",
    querySource: "main_turn",
    turnId: "turn-e2e-trv-seed",
    startedAt: iso(at(1)),
    completedAt: iso(at(1) + SEED_DURATION_MS),
    durationMs: SEED_DURATION_MS,
    model: knownModel,
    timing: { stream: true, timeToFirstProviderEventMs: 90, timeToFirstContentMs: 210 },
    request: {
      // A writer delta over record0's input; the expansion restores the tool-result context.
      messagesKind: "delta",
      messageOffset: 1,
      messages: [
        {
          role: "tool",
          content: "E2E_TRV02_TOOL_RESULT_0",
          toolCallId: "toolu_e2e_trv_read_0",
          toolName: "Read",
        },
      ],
      toolNames: ["Bash", "Read", "Glob"],
      body: wireBodyB,
    },
    response: {
      finishReason: "tool-calls",
      text: "E2E_TRV02_ASSISTANT_1",
      toolCalls: [
        { id: "toolu_e2e_trv_glob_1", name: "Glob", input: { pattern: "E2E_TRV02_PATTERN" } },
      ],
      usage: { inputTokens: 45_000, outputTokens: 90, cacheReadTokens: 30_000 },
    },
  };

  const compactRecord = {
    type: "model_io",
    sessionId: taskId,
    requestId: "e2e-trv-compact",
    querySource: "compact",
    startedAt: iso(at(2)),
    completedAt: iso(at(2) + 6_000),
    durationMs: 6_000,
    model: knownModel,
    request: {
      messages: [{ role: "user", content: "E2E_TRV02_COMPACT_SUMMARY" }],
      toolNames: [],
    },
    response: {
      finishReason: "stop",
      text: "E2E_TRV02_COMPACT_OUTPUT",
      usage: { inputTokens: 30_000, outputTokens: 8_000 },
    },
  };

  // A legacy record: written before wire bodies and timing existed (specs/model-trajectory-v2.md,
  // "Compatibility and version skew").
  const legacyRecord = {
    type: "model_io",
    sessionId: taskId,
    requestId: "e2e-trv-r003",
    querySource: "main_turn",
    startedAt: iso(at(3)),
    completedAt: iso(at(3) + SEED_DURATION_MS),
    durationMs: SEED_DURATION_MS,
    model: LEGACY_MODEL,
    request: {
      messages: [{ role: "user", content: "E2E_TRV02_LEGACY_USER" }],
      toolNames: ["Bash", "Read"],
    },
    response: {
      finishReason: "stop",
      text: "E2E_TRV02_LEGACY_ASSISTANT",
      usage: { inputTokens: 1_200, outputTokens: 40 },
    },
  };

  return [
    record0,
    record1,
    compactRecord,
    legacyRecord,
    ...Array.from({ length: BULK_COUNT }, (_, step) =>
      createBulkRecord(taskId, {
        index: 4 + step,
        offset: 1 + step,
        startedAtMs: at(4 + step),
        requestId: `e2e-trv-b${String(4 + step).padStart(3, "0")}`,
        userText: `trv bulk user ${4 + step}`,
        assistantText: `trv bulk assistant ${4 + step}`,
      }),
    ),
  ];
}

function createBulkRecord(
  taskId: string,
  options: {
    index: number;
    offset: number;
    startedAtMs: number;
    requestId: string;
    userText: string;
    assistantText: string;
    full?: boolean;
  },
) {
  return {
    type: "model_io",
    sessionId: taskId,
    requestId: options.requestId,
    querySource: "main_turn",
    startedAt: iso(options.startedAtMs),
    completedAt: iso(options.startedAtMs + SEED_DURATION_MS),
    durationMs: SEED_DURATION_MS,
    model: LEGACY_MODEL,
    request: options.full
      ? {
          messages: [{ role: "user", content: options.userText }],
          toolNames: [],
        }
      : {
          // Writer deltas keep each bulk record's expansion one message longer than the previous,
          // so the input-delta projection mounts a single user row per call.
          messagesKind: "delta",
          messageOffset: options.offset,
          messages: [{ role: "user", content: options.userText }],
          toolNames: [],
        },
    response: {
      finishReason: "stop",
      text: options.assistantText,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
  };
}

async function waitForActualTrajectory(
  taskId: string,
  predicate: (record: ActualTrajectoryRecord) => boolean,
): Promise<{ filePath: string; records: ActualTrajectoryRecord[] }> {
  const safeTaskId = taskId
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const fileName = `model-io-${safeTaskId || "no-session"}.jsonl`;
  const candidates = ["debug", "rollout"].map((mode) =>
    join(paths.storageRoot, "cli", mode, fileName),
  );
  let result: { filePath: string; records: ActualTrajectoryRecord[] } | null = null;

  await browser.waitUntil(
    async () => {
      for (const filePath of candidates) {
        const records = await readTrajectoryRecords(filePath, taskId);
        if (records.some(predicate)) {
          result = { filePath, records };
          return true;
        }
      }
      return false;
    },
    { timeout: 20_000, timeoutMsg: "CLI 没有写出满足条件的真实 model-io 记录" },
  );

  return result as NonNullable<typeof result>;
}

async function readTrajectoryRecords(filePath: string, taskId: string) {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ActualTrajectoryRecord];
      } catch {
        return [];
      }
    })
    .filter((record) => record.type === "model_io" && record.sessionId === taskId);
}

async function openTrajectoryV2ThroughTaskMenu(taskId: string) {
  await browser.waitUntil(
    () =>
      browser.execute((currentTaskId) => {
        const item = [...document.querySelectorAll<HTMLElement>("[data-testid]")].find((element) =>
          element.getAttribute("data-testid")?.endsWith(currentTaskId),
        );
        if (!item) return false;
        const rect = item.getBoundingClientRect();
        item.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
        return true;
      }, taskId),
    { timeout: 15_000, timeoutMsg: `侧栏中没有找到真实 task item: ${taskId}` },
  );

  // The v1 entry must survive next to the new v2 entry (specs/model-trajectory-v2.md: v1 stays unchanged).
  await browser.waitUntil(
    () =>
      browser.execute(
        (v1TestId, v2TestId) => {
          const menuV1 = document.querySelector(`[data-testid="${v1TestId}"]`);
          const item = document.querySelector<HTMLElement>(`[data-testid="${v2TestId}"]`);
          item?.click();
          return Boolean(menuV1) && Boolean(item);
        },
        TID_TASK_VIEW_MODEL_TRAJECTORY,
        TID_TASK_VIEW_MODEL_TRAJECTORY_V2,
      ),
    { timeout: 15_000, timeoutMsg: "task context menu 缺少 v1/v2 调用轨迹入口" },
  );
}

async function closeTrajectoryV2Tab(taskId: string) {
  await browser.waitUntil(
    () =>
      browser.execute((currentTaskId) => {
        const tab = document.querySelector<HTMLElement>(
          `[data-side-pane-tab-id="model-trajectory-v2:${currentTaskId}"]`,
        );
        const closeButton = tab?.querySelector<HTMLButtonElement>("button[aria-label]");
        if (!closeButton) return false;
        closeButton.click();
        return true;
      }, taskId),
    { timeout: 10_000, timeoutMsg: `v2 tab for task ${taskId} has no close button` },
  );
}

async function v2PaneExists() {
  return browser.execute(() =>
    Boolean(
      [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")].some(
        (element) => element.offsetParent !== null,
      ),
    ),
  );
}

async function waitForV2State(state: string, message: string) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
        const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
        return pane?.getAttribute("data-trajectory-v2-state") ?? null;
      })) === state,
    { timeout: 20_000, timeoutMsg: message },
  );
}

async function v2SummaryItems() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return [
      ...(pane?.querySelectorAll<HTMLElement>("[data-trajectory-v2-summary-item]") ?? []),
    ].map((element) => element.getAttribute("data-trajectory-v2-summary-item") ?? "");
  });
}

async function v2ToolTimeSource() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return (
      pane
        ?.querySelector<HTMLElement>("[data-trajectory-v2-tool-time]")
        ?.getAttribute("data-trajectory-v2-tool-time") ?? null
    );
  });
}

async function v2ContextChartMode() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return (
      pane
        ?.querySelector<HTMLElement>("[data-trajectory-v2-context-chart]")
        ?.getAttribute("data-trajectory-v2-context-chart") ?? null
    );
  });
}

async function v2HasContextMarker(marker: string) {
  return browser.execute((markerName) => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return Boolean(pane?.querySelector(`[data-trajectory-v2-context-marker="${markerName}"]`));
  }, marker);
}

async function v2LedgerSnapshot() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    const ledger = pane?.querySelector<HTMLElement>("[data-trajectory-v2-ledger]") ?? null;
    const rows = ledger
      ? [...ledger.querySelectorAll<HTMLElement>("[data-trajectory-v2-row-kind]")]
      : [];
    return {
      kinds: [...new Set(rows.map((row) => row.getAttribute("data-trajectory-v2-row-kind") ?? ""))],
      toolRows: rows
        .filter((row) => row.getAttribute("data-trajectory-v2-row-kind") === "tool")
        .map((row) => row.textContent ?? ""),
      mountedRows: rows.length,
    };
  });
}

async function v2MarkerTexts() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return [
      ...(pane?.querySelectorAll<HTMLElement>('[data-trajectory-v2-row-kind="marker"]') ?? []),
    ].map((row) => row.textContent?.trim() ?? "");
  });
}

async function v2RowCount() {
  const value = await browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return (
      pane
        ?.querySelector<HTMLElement>("[data-trajectory-v2-ledger]")
        ?.getAttribute("data-trajectory-v2-row-count") ?? null
    );
  });
  return value === null ? null : Number(value);
}

async function v2SelectedKey() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    // The selected row may be filtered out or outside the virtual window; the inspector always names it.
    return (
      pane
        ?.querySelector<HTMLElement>('[data-trajectory-v2-selected="true"]')
        ?.getAttribute("data-trajectory-v2-row-key") ??
      pane
        ?.querySelector<HTMLElement>("[data-trajectory-v2-inspector-key]")
        ?.getAttribute("data-trajectory-v2-inspector-key") ??
      null
    );
  });
}

async function v2SelectedRowMounted() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    const row = pane?.querySelector<HTMLElement>('[data-trajectory-v2-selected="true"]');
    return Boolean(row && row.offsetParent !== null);
  });
}

async function selectV2Row(keyPrefix: string) {
  await browser.waitUntil(
    () =>
      browser.execute((prefix) => {
        const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
        const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0];
        // A narrow pane shows the inspector as a drill-in view in place of the ledger; go back first.
        pane?.querySelector<HTMLElement>("[data-trajectory-v2-drill-in] button")?.click();
        const row = pane?.querySelector<HTMLElement>(`[data-trajectory-v2-row-key^="${prefix}"]`);
        row?.click();
        return Boolean(row);
      }, keyPrefix),
    { timeout: 15_000, timeoutMsg: `v2 ledger 没有 key 前缀为 ${keyPrefix} 的行` },
  );
}

async function v2RowChangeChips(keyPrefix: string) {
  return browser.execute((prefix) => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    const row = pane?.querySelector<HTMLElement>(`[data-trajectory-v2-row-key^="${prefix}"]`);
    return [...(row?.querySelectorAll<HTMLElement>("[data-trajectory-v2-change]") ?? [])].map(
      (chip) => ({
        kind: chip.getAttribute("data-trajectory-v2-change") ?? "",
        text: chip.textContent?.trim() ?? "",
      }),
    );
  }, keyPrefix);
}

async function v2InspectorKind() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return (
      pane
        ?.querySelector<HTMLElement>("[data-trajectory-v2-inspector]")
        ?.getAttribute("data-trajectory-v2-inspector") ?? null
    );
  });
}

async function clickV2Tab(tab: string) {
  await browser.waitUntil(
    () =>
      browser.execute((name) => {
        const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
        const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0];
        const trigger = pane?.querySelector<HTMLElement>(`[data-trajectory-v2-tab="${name}"]`);
        if (!trigger) return false;
        // Radix Tabs activate on mousedown, not click.
        trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        trigger.click();
        return trigger.getAttribute("data-state") === "active";
      }, tab),
    { timeout: 10_000, timeoutMsg: `inspector 没有 ${tab} tab` },
  );
}

async function v2InspectorFields() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    const fields: Record<string, string> = {};
    for (const dt of pane?.querySelectorAll<HTMLElement>("dt") ?? []) {
      fields[dt.textContent?.trim() ?? ""] = dt.nextElementSibling?.textContent?.trim() ?? "";
    }
    return fields;
  });
}

async function v2PayloadText() {
  const read = () =>
    browser.execute(() => {
      const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
      const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
      return (
        pane?.querySelector<HTMLElement>('[data-trajectory-v2-payload="request"]')?.textContent ??
        ""
      );
    });
  // The tab content mounts a render after the trigger becomes active.
  await browser.waitUntil(async () => (await read()).length > 0, {
    timeout: 10_000,
    timeoutMsg: "request Payload tab did not render",
  });
  return read();
}

async function v2CatalogNames() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return [...(pane?.querySelectorAll<HTMLElement>("[data-trajectory-v2-catalog] li") ?? [])].map(
      (item) => (item.querySelector("span") ?? item).textContent?.trim() ?? "",
    );
  });
}

async function v2SchemaText(toolName: string) {
  return browser.execute((name) => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return (
      pane?.querySelector<HTMLElement>(`[data-trajectory-v2-schema="${name}"]`)?.textContent ?? ""
    );
  }, toolName);
}

async function clickV2Refresh() {
  await browser.waitUntil(
    () =>
      browser.execute((testId) => {
        const buttons = [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
        const button = buttons.find((element) => element.offsetParent !== null) ?? buttons[0];
        button?.click();
        return Boolean(button);
      }, TID_MODEL_TRAJECTORY_V2_REFRESH),
    { timeout: 10_000, timeoutMsg: "v2 pane 没有可点击的刷新按钮" },
  );
}

async function v2RangeAttribute() {
  return browser.execute(() => {
    const strips = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-strip]")];
    const strip = strips.find((element) => element.offsetParent !== null) ?? strips[0];
    return (
      strip
        ?.querySelector("[data-trajectory-v2-strip-svg]")
        ?.getAttribute("data-trajectory-v2-range") ?? null
    );
  });
}

async function stripRect() {
  return browser.execute(() => {
    const strips = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-strip]")];
    const strip = strips.find((element) => element.offsetParent !== null) ?? strips[0];
    const svg = strip?.querySelector<SVGSVGElement>("[data-trajectory-v2-strip-svg]");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
}

/** Drag horizontally across the strip with real pointer events (React pointer capture needs them). */
async function dragOnStrip(fromRatio: number, toRatio: number) {
  const rect = await stripRect();
  if (!rect || rect.width <= 0) throw new Error("v2 strip 没有可拖拽的 svg");
  const y = rect.top + Math.min(rect.height - 2, 6);
  const fromX = rect.left + rect.width * fromRatio;
  const toX = rect.left + rect.width * toRatio;
  await browser.performActions([
    {
      id: "trv2-strip-drag",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: Math.round(fromX), y: Math.round(y) },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        { type: "pointerMove", duration: 200, x: Math.round(toX), y: Math.round(y) },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

/** Click (press + release under the 3px drag threshold) the span of a row key prefix. */
async function clickStripSpan(keyPrefix: string) {
  const center = await browser.execute((prefix) => {
    const strips = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-strip]")];
    const strip = strips.find((element) => element.offsetParent !== null) ?? strips[0];
    const span = strip?.querySelector<SVGGElement>(`g[data-span-key^="${prefix}"]`);
    if (!span) return null;
    const rect = span.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, keyPrefix);
  if (!center) throw new Error(`strip 上没有 key 前缀为 ${keyPrefix} 的 span`);
  await browser.performActions([
    {
      id: "trv2-span-click",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: Math.round(center.x), y: Math.round(center.y) },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 60 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

async function clickFirstDisplayed(selector: string) {
  await browser.waitUntil(
    () =>
      browser.execute((value) => {
        const element = [...document.querySelectorAll<HTMLElement>(value)].find(
          (candidate) => candidate.offsetParent !== null,
        );
        element?.click();
        return Boolean(element);
      }, selector),
    { timeout: 10_000, timeoutMsg: `没有找到可点击的可见元素: ${selector}` },
  );
}

async function scrollLedgerTo(ratio: number) {
  await browser.execute((scrollRatio) => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0];
    const ledger = pane?.querySelector<HTMLElement>("[data-trajectory-v2-ledger]");
    if (ledger) ledger.scrollTop = ledger.scrollHeight * scrollRatio;
  }, ratio);
}

async function focusLedger() {
  await browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0];
    pane?.querySelector<HTMLElement>("[data-trajectory-v2-ledger]")?.focus();
  });
}

async function installV2StateObserver() {
  const installed = await browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0];
    if (!pane) return false;
    const target = window as typeof window & {
      __trv2StateTransitions?: string[];
      __trv2PaneRef?: HTMLElement;
    };
    target.__trv2StateTransitions = [];
    target.__trv2PaneRef = pane;
    new MutationObserver(() => {
      target.__trv2StateTransitions?.push(pane.getAttribute("data-trajectory-v2-state") ?? "");
    }).observe(pane, { attributes: true, attributeFilter: ["data-trajectory-v2-state"] });
    return true;
  });
  if (!installed) throw new Error("TRV05 没有找到可观察的 v2 pane");
}

async function readV2StateObserver() {
  return browser.execute(() => {
    const target = window as typeof window & {
      __trv2StateTransitions?: string[];
      __trv2PaneRef?: HTMLElement;
    };
    return {
      transitions: [...(target.__trv2StateTransitions ?? [])],
      paneStillMounted: Boolean(target.__trv2PaneRef && document.contains(target.__trv2PaneRef)),
    };
  });
}

async function v2Layout() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return pane?.getAttribute("data-trajectory-v2-layout") ?? null;
  });
}

async function v2DrillInExists() {
  return browser.execute(() => {
    const panes = [...document.querySelectorAll<HTMLElement>("[data-trajectory-v2-state]")];
    const pane = panes.find((element) => element.offsetParent !== null) ?? panes[0] ?? null;
    return Boolean(pane?.querySelector("[data-trajectory-v2-drill-in]"));
  });
}

async function v2PageHorizontalOverflow() {
  return browser.execute(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

async function setRendererLocale(locale: "en-US") {
  const changed = await browser.execute((nextLocale) => {
    const actions = (
      window as typeof window & {
        __testActions?: Record<string, unknown>;
      }
    ).__testActions;
    const setLocale = actions?.setLocale;
    if (typeof setLocale !== "function") return false;
    (setLocale as (value: string) => void)(nextLocale);
    return true;
  }, locale);
  if (!changed) {
    throw new Error(`TRV case 缺少 renderer locale test action: ${locale}`);
  }
  await browser.waitUntil(
    async () =>
      browser.execute((expectedLocale) => {
        const actions = (
          window as typeof window & {
            __testActions?: Record<string, unknown>;
          }
        ).__testActions;
        const getLocale = actions?.getLocale;
        return typeof getLocale === "function" && getLocale() === expectedLocale;
      }, locale),
    { timeout: 15_000, timeoutMsg: `renderer locale 没有切换到 ${locale}` },
  );
}
