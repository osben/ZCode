import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_ERROR_DETAILS_BUTTON,
  TID_CHAT_ERROR_HOOK_ICON,
  TID_V4_HOOK_DETAILS_CONTENT,
  TID_V4_HOOK_DETAILS_TRIGGER,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  seedSettings,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import {
  countUpstreamRequests,
  countUpstreamRequestsContaining,
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "../helpers/conversation-session-network.js";
import { waitForUpstreamNetworkCapture } from "../helpers/upstream-capture.js";
import { selectUpstreamModel, selectUpstreamThoughtLevel } from "../helpers/upstream-provider.js";
import {
  findHookEvent,
  hasHookRecord,
  HOOKS_CASE_MARKERS,
  HOOKS_CONTEXT,
  HOOKS_ERROR_DETAIL,
  HOOKS_FINAL_MARKERS,
  HOOKS_REASON,
  HOOKS_RELATIVE_PATHS,
  HOOKS_TOOL_CALL_IDS,
  installHooksLifecycleFixture,
  readHookTraceRecords,
  processHookRecords,
  restoreHooksLifecycleFixture,
  toolHookContextText,
  waitForHookScenarioTrace,
  type HookTraceRecord,
} from "../helpers/hooks-lifecycle-fixture.js";
import { waitForCompactMarkerStatuses } from "../helpers/conversation-session-compact.js";
import { sel } from "../helpers/selectors.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import {
  getV4ComposerText,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft as startEmptyV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const STOP_STEP = (index: number) => `${HOOKS_CASE_MARKERS.stopCap}_STEP_${index}`;

// A tool hook's context does not enter the tool text proper: as a post-batch reminder, one
// system-reminder each, adjacent in order; on the non-MCS Messages protocol, post-batch
// reminders are merged into the batch's last tool result, after the tool text.
async function expectToolHookContextsAfterResult(toolCallId: string, contexts: string[]) {
  const result = await getLatestUpstreamToolResultByToolCallId(toolCallId);
  expect(result).not.toBeNull();
  const reminders = contexts
    .map((context) => `<system-reminder>\n${context}\n</system-reminder>`)
    .join("\n\n");
  const reminderIndex = result!.content.indexOf(`\n\n${reminders}`);
  expect(reminderIndex).toBeGreaterThan(0);
  const rawResult = result!.content.slice(0, reminderIndex);
  for (const context of contexts) expect(rawResult).not.toContain(context);
  expect(result!.content).not.toContain("[Hook additional context]");
}
async function startNewV4Draft() {
  await startEmptyV4Draft();
  // Hook cases do not test the default model; each new draft selects explicitly and must not rely on old Recent auto-backfill.
  await selectUpstreamModel();
  await selectUpstreamThoughtLevel();
}
const HOOK_BLOCK_SCREENSHOT_DIR = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() || join(process.cwd(), ".e2e-artifacts"),
  "hooks-block-reason",
);

describe("Hooks full-chain E2E", () => {
  before(async function () {
    this.timeout(120000);
    await installHooksLifecycleFixture();
    await seedSettings({ locale: "en-US", localePreference: "en-US" });
    // The new isolated profile's three-step onboarding overwrites the workspace; finish the real UI first, then enter Hook acceptance.
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await restoreHooksLifecycleFixture();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HK-LC-01: runs seven events, all executors, compatible stdin, and event effects", async function () {
    this.timeout(180000);
    const prompt = `${HOOKS_CASE_MARKERS.fullChain}: run the configured modified Write and failing Read chain, then reply with exactly ${HOOKS_FINAL_MARKERS.fullChain}.`;

    await assertHooksSettingsPage();
    await sendV4Prompt(prompt);
    await waitForEmptyV4Composer("Full-chain Hooks prompt did not clear the composer");
    await waitForV4TimelineContaining(HOOKS_CASE_MARKERS.fullChain);
    // Bug root cause: Hook acceptance mistook a collapsed tool card in the V4 virtual timeline for the runtime completion
    // barrier; the card may have slid out of the window, but the subsequent provider request and trace are this case's
    // authoritative evidence. Avoid blocking the Hooks full-chain assertions on irrelevant UI visibility.
    await waitForV4TimelineContaining(HOOKS_FINAL_MARKERS.fullChain);
    await waitForIdle("Full-chain Hooks case did not return to idle");

    await waitForUpstreamRequest(
      {
        includes: [HOOKS_CASE_MARKERS.fullChain, HOOKS_CONTEXT.session, HOOKS_CONTEXT.prompt],
        excludes: [HOOKS_CONTEXT.asyncIgnored],
      },
      "First full-chain request did not receive lifecycle context",
      60000,
    );
    await waitForUpstreamRequest(
      {
        includes: [
          HOOKS_TOOL_CALL_IDS.fullWrite,
          HOOKS_RELATIVE_PATHS.fullFinal,
          HOOKS_CONTEXT.preWrite,
          HOOKS_CONTEXT.post,
        ],
      },
      "Modified Write result did not expose final input and Hook context",
      60000,
    );
    await waitForUpstreamRequest(
      {
        includes: [HOOKS_TOOL_CALL_IDS.fullRead, HOOKS_CONTEXT.preRead, HOOKS_CONTEXT.failure],
      },
      "Failed Read result did not expose recovery Hook context",
      60000,
    );
    await expectToolHookContextsAfterResult(HOOKS_TOOL_CALL_IDS.fullWrite, [
      toolHookContextText("PreToolUse", "Write", HOOKS_CONTEXT.preWrite),
      toolHookContextText("PostToolUse", "Write", HOOKS_CONTEXT.post),
    ]);
    await expectToolHookContextsAfterResult(HOOKS_TOOL_CALL_IDS.fullRead, [
      toolHookContextText("PreToolUse", "Read", HOOKS_CONTEXT.preRead),
      toolHookContextText("PostToolUseFailure", "Read", HOOKS_CONTEXT.failure),
    ]);

    expect(await readFile(workspacePath(HOOKS_RELATIVE_PATHS.fullFinal), "utf8")).toBe(
      "permission modified content\n",
    );
    await expectMissingPath(HOOKS_RELATIVE_PATHS.fullOriginal);
    await expectMissingPath(HOOKS_RELATIVE_PATHS.fullPreModified);

    const trace = await waitForHookScenarioTrace(
      HOOKS_CASE_MARKERS.fullChain,
      (records) =>
        hasHookRecord(records, {
          executor: "process",
          hook_event_name: "Stop",
          phase: "completed",
        }) &&
        hasHookRecord(records, {
          executor: "command-async",
          hook_event_name: "UserPromptSubmit",
          phase: "completed",
        }),
      "Full-chain Hook trace did not complete",
    );
    assertFullChainTrace(trace, prompt);
    await assertHookTurnDetails(HOOKS_FINAL_MARKERS.fullChain);
  });

  it("HK-EF-01: preserves additionalContext on every handler-before failure", async function () {
    this.timeout(180000);
    await startNewV4Draft();
    const prompt = `${HOOKS_CASE_MARKERS.earlyFailures}: trigger PreToolUse deny, invalid updatedInput, and PermissionRequest deny, then reply with exactly ${HOOKS_FINAL_MARKERS.earlyFailures}.`;

    await sendV4Prompt(prompt);
    await waitForEmptyV4Composer("Early-failure Hooks prompt did not clear the composer");
    await waitForV4TimelineContaining(HOOKS_CASE_MARKERS.earlyFailures);
    // Bug root cause: the final marker is also written into the user prompt, so searching the whole timeline for the text
    // could falsely report completion before the provider request even started. First prove via capture that the main
    // request completed, then wait for the final reply only in assistant rows, so shard load cannot push trace assertions too early.
    await waitForUpstreamNetworkCapture(HOOKS_CASE_MARKERS.earlyFailures);
    await waitForV4AssistantMessageContaining(HOOKS_FINAL_MARKERS.earlyFailures);
    await waitForIdle("Early-failure Hooks case did not return to idle");

    for (const [toolCallId, context] of [
      [HOOKS_TOOL_CALL_IDS.earlyPreDeny, HOOKS_CONTEXT.preDeny],
      [HOOKS_TOOL_CALL_IDS.earlyInvalid, HOOKS_CONTEXT.invalidUpdate],
      [HOOKS_TOOL_CALL_IDS.earlyPermissionDeny, HOOKS_CONTEXT.permissionDeny],
    ] as const) {
      await waitForUpstreamRequest(
        { includes: [toolCallId, context] },
        `Early failure lost Hook context for ${toolCallId}`,
        60000,
      );
      await expectToolHookContextsAfterResult(toolCallId, [
        toolHookContextText("PreToolUse", "Write", context),
      ]);
    }
    await waitForUpstreamRequest(
      {
        includes: [HOOKS_TOOL_CALL_IDS.earlyPermissionDeny, HOOKS_REASON.permissionDeny],
      },
      "PermissionRequest deny reason did not reach the model",
      60000,
    );

    for (const path of [
      HOOKS_RELATIVE_PATHS.earlyPreDeny,
      HOOKS_RELATIVE_PATHS.earlyInvalid,
      HOOKS_RELATIVE_PATHS.earlyInvalidTarget,
      HOOKS_RELATIVE_PATHS.earlyPermissionDeny,
    ]) {
      await expectMissingPath(path);
    }

    const trace = await waitForHookScenarioTrace(
      HOOKS_CASE_MARKERS.earlyFailures,
      (records) =>
        hasHookRecord(records, {
          executor: "process",
          hook_event_name: "Stop",
        }),
      "Early-failure Hook trace did not complete",
    );
    assertEarlyFailureTrace(trace);
  });

  it("HK-ST-01: caps consecutive Stop continuations at three", async function () {
    this.timeout(180000);
    await startNewV4Draft();
    const prompt = `${HOOKS_CASE_MARKERS.stopCap}: keep revising only when the Stop hook asks.`;

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(HOOKS_CASE_MARKERS.stopCap);
    await waitForV4TimelineContaining(STOP_STEP(3));
    await waitForIdle("Stop-cap Hooks case did not return to idle");

    expect(await countUpstreamRequestsContaining(HOOKS_CASE_MARKERS.stopCap)).toBe(4);
    for (const index of [1, 2, 3]) {
      await waitForUpstreamRequest(
        { includes: [HOOKS_CASE_MARKERS.stopCap, HOOKS_CONTEXT.stop(index)] },
        `Stop continuation request ${index} did not receive Hook context`,
        60000,
      );
    }
    expect(
      await countUpstreamRequests({
        includes: [HOOKS_CASE_MARKERS.stopCap, HOOKS_CONTEXT.stop(4)],
      }),
    ).toBe(0);

    const trace = await waitForHookScenarioTrace(
      HOOKS_CASE_MARKERS.stopCap,
      (records) =>
        processHookRecords(records).filter((record) => record.hook_event_name === "Stop").length ===
        4,
      "Stop Hook did not execute four boundary checks",
    );
    assertStopCapTrace(trace);
  });

  it("HK-UP-01: blocks UserPromptSubmit before the model and isolates async output", async function () {
    this.timeout(120000);
    await startNewV4Draft();
    const prompt = `${HOOKS_CASE_MARKERS.promptBlock}: this prompt must be blocked before the model.`;

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(HOOKS_CASE_MARKERS.promptBlock);
    await waitForIdle("Prompt-block Hooks case did not return to idle");
    const trace = await waitForHookScenarioTrace(
      HOOKS_CASE_MARKERS.promptBlock,
      (records) =>
        hasHookRecord(records, {
          executor: "command-async",
          hook_event_name: "UserPromptSubmit",
          phase: "completed",
        }),
      "Async command Hook did not finish after prompt blocking",
    );

    expect(await countUpstreamRequestsContaining(HOOKS_CASE_MARKERS.promptBlock)).toBe(0);
    expect(await countUpstreamRequests({ includes: [HOOKS_CONTEXT.asyncIgnored] })).toBe(0);
    expect(
      hasHookRecord(trace, {
        executor: "process",
        hook_event_name: "UserPromptSubmit",
        phase: "completed",
      }),
    ).toBe(true);
    expect(
      hasHookRecord(trace, {
        executor: "command-async",
        hook_event_name: "UserPromptSubmit",
        phase: "started",
      }),
    ).toBe(true);
    expect(processHookRecords(trace).some((record) => record.hook_event_name === "Stop")).toBe(
      false,
    );

    const readTriggerTestId = () =>
      browser.execute(
        (marker: string, triggerPrefix: string) => {
          const turn = Array.from(document.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
            (candidate) => candidate.textContent?.includes(marker),
          );
          return (
            turn
              ?.querySelector<HTMLElement>(`[data-testid^="${triggerPrefix}-"]`)
              ?.getAttribute("data-testid") ?? null
          );
        },
        HOOKS_CASE_MARKERS.promptBlock,
        TID_V4_HOOK_DETAILS_TRIGGER,
      );
    await browser.waitUntil(async () => (await readTriggerTestId()) !== null, {
      timeout: 15000,
      timeoutMsg: "Blocked prompt Hook details trigger did not appear",
    });
    const detailsTriggerTestId = await readTriggerTestId();
    if (!detailsTriggerTestId) throw new Error("Missing blocked prompt Hook details trigger");
    const hookActionText = await browser.execute((triggerTestId: string) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      return trigger?.parentElement?.textContent ?? "";
    }, detailsTriggerTestId);
    expect(hookActionText).not.toContain(HOOKS_REASON.promptBlock);

    await browser.waitUntil(
      async () =>
        (
          await browser.execute((testId: string) => {
            return (
              document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent ?? ""
            );
          }, TID_CHAT_ERROR_BANNER)
        ).includes(`hooks_prompt_block: ${HOOKS_ERROR_DETAIL.promptBlock}`),
      {
        timeout: 15000,
        timeoutMsg: "Blocked prompt Hook reason did not appear in the chat error banner",
      },
    );

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (detailsTestId: string, hookIconTestId: string) =>
            Boolean(
              document.querySelector(`[data-testid="${detailsTestId}"]`) &&
              document.querySelector(`[data-testid="${hookIconTestId}"]`),
            ),
          TID_CHAT_ERROR_DETAILS_BUTTON,
          TID_CHAT_ERROR_HOOK_ICON,
        ),
      {
        timeout: 15000,
        timeoutMsg: "Hook block Chat Error details action or icon did not appear",
      },
    );
    await browser.execute((detailsTestId: string) => {
      document.querySelector<HTMLElement>(`[data-testid="${detailsTestId}"]`)?.click();
    }, TID_CHAT_ERROR_DETAILS_BUTTON);
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (errorDetail: string) =>
            document.querySelector('[role="dialog"]')?.textContent?.includes(errorDetail) ?? false,
          HOOKS_ERROR_DETAIL.promptBlock,
        ),
      {
        timeout: 15000,
        timeoutMsg: "Hook block Chat Error details dialog did not show stderr",
      },
    );

    // The screenshot is only a manual-review artifact; pass/fail still relies on the stable DOM text assertions above.
    await mkdir(HOOK_BLOCK_SCREENSHOT_DIR, { recursive: true });
    await browser.saveScreenshot(join(HOOK_BLOCK_SCREENSHOT_DIR, "HK-UP-01-chat-error.png"));
  });

  it("HK-UP-ERR-01: reports a UserPromptSubmit process failure before the model", async function () {
    this.timeout(120000);
    await startNewV4Draft();
    const prompt = `${HOOKS_CASE_MARKERS.promptError}: the hook must fail before the model.`;

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(HOOKS_CASE_MARKERS.promptError);
    await waitForV4AssistantMessageContaining("HOOK_PROCESS_FAILURE_REACHED_MODEL");
    await waitForIdle("Prompt-error Hooks case did not return to idle");

    expect(await countUpstreamRequestsContaining(HOOKS_CASE_MARKERS.promptError)).toBe(1);
    let trace: HookTraceRecord[] = [];
    await browser.waitUntil(
      async () => {
        trace = (await readHookTraceRecords()).filter(
          (record) =>
            typeof record.prompt === "string" &&
            record.prompt.includes(HOOKS_CASE_MARKERS.promptError),
        );
        return hasHookRecord(trace, {
          executor: "process",
          hook_event_name: "UserPromptSubmit",
          phase: "started",
        });
      },
      {
        timeout: 30000,
        timeoutMsg: "Failing UserPromptSubmit Hook did not start",
      },
    );
    expect(
      hasHookRecord(trace, {
        executor: "process",
        hook_event_name: "UserPromptSubmit",
        phase: "completed",
      }),
    ).toBe(false);
  });

  it("HK17: keeps the SessionStart summary off a first-action /compact maintenance turn", async function () {
    // Bug root cause: the Runtime's runSessionStartHooks executes before /compact input parsing; when the first
    // input is /compact, the SessionStart Hook really executes and its event carries the compact turnId, the projection
    // layer attached the summary to the model-only maintenance turn, and the UI therefore showed the Hook icon in the
    // compact marker round. The regression asserts three layers: no icon in the compact round, the summary attached to
    // the next real turn, and SessionStart visible in that real turn's details.
    this.timeout(180000);
    await startNewV4Draft();

    await sendV4Prompt("/compact");
    // With empty history a manual compact is a noop (context is already current, nothing to compress);
    // maintenance turn semantics unchanged: TurnStarted stays model-only and the SessionStart Hook still executed.
    await waitForCompactMarkerStatuses(["completed", "skipped"], "manual");
    await waitForIdle("Compact-first Hooks case did not return to idle");

    // The maintenance turn renders no Hook Anchor: the turn containing the compact marker has no Hook entry.
    const compactTurnHasHookTrigger = await browser.execute((triggerPrefix: string) => {
      const marker = document.querySelector<HTMLElement>(
        '[data-row-kind="timelineMarker"][data-marker-type="compact"]',
      );
      const turn = marker?.closest<HTMLElement>("[data-turn-id]");
      return turn != null && turn.querySelector(`[data-testid^="${triggerPrefix}-"]`) !== null;
    }, TID_V4_HOOK_DETAILS_TRIGGER);
    expect(compactTurnHasHookTrigger).toBe(false);

    // Only the next real prompt carries the SessionStart summary.
    const followUpMarker = "E2E_HOOKS_COMPACT_FIRST_FOLLOW_UP_OK";
    await sendV4Prompt(`Reply with exactly ${followUpMarker} and nothing else.`);
    await waitForV4TimelineContaining(followUpMarker);
    await waitForIdle("Follow-up prompt did not return to idle");

    // Under the virtual timeline, anchor on the Hook entry itself: any Hook trigger present must land in the real
    // turn containing the marker text, not the compact maintenance turn.
    const readHookTriggerOwner = () =>
      browser.execute(
        (marker: string, triggerPrefix: string) => {
          const triggers = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${triggerPrefix}-"]`),
          );
          const markerTurn = Array.from(
            document.querySelectorAll<HTMLElement>("[data-turn-id]"),
          ).find((candidate) => candidate.textContent?.includes(marker));
          return {
            triggerCount: triggers.length,
            markerTurnFound: markerTurn != null,
            markerTurnHasTrigger:
              markerTurn != null &&
              markerTurn.querySelector(`[data-testid^="${triggerPrefix}-"]`) !== null,
          };
        },
        followUpMarker,
        TID_V4_HOOK_DETAILS_TRIGGER,
      );
    await browser.waitUntil(
      async () => {
        const state = await readHookTriggerOwner();
        return state.triggerCount >= 1 && state.markerTurnFound && state.markerTurnHasTrigger;
      },
      {
        timeout: 20000,
        timeoutMsg: "Follow-up real turn did not own the SessionStart Hook summary",
      },
    );

    await assertHookTurnDetails(followUpMarker, {
      // The follow-up is a plain text reply with no tool Hook; SessionStart (once before and once after compact)
      // plus UserPromptSubmit and Stop are the authoritative summary content for this turn.
      expectedEvents: ["SessionStart", "UserPromptSubmit", "Stop"],
      expectedRowCount: 5,
      expectedCountByEvent: { SessionStart: 2, UserPromptSubmit: 2, Stop: 1 },
      skipOverflowAssertions: true,
    });
  });
});

async function assertHooksSettingsPage(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Hooks E2E could not open Settings",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "hooks"), {
    timeout: 15000,
    timeoutMsg: "Settings did not expose the Hooks section",
  });
  await $('[data-testid="hooks-settings-section"]').waitForDisplayed({
    timeout: 15000,
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.querySelectorAll('[data-testid="configured-hook-row"]').length === 13,
      ),
    {
      timeout: 15000,
      timeoutMsg: "Hooks settings did not render all nine configured hooks",
    },
  );
  const settingsText = await $('[data-testid="hooks-settings-section"]').getText();
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]) {
    expect(settingsText).toContain(event);
  }
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Hooks settings did not expose the back button",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function assertHookTurnDetails(
  finalAssistantMarker: string,
  options: {
    expectedEvents?: readonly string[];
    expectedRowCount?: number;
    expectedCountByEvent?: Readonly<Record<string, number>>;
    skipOverflowAssertions?: boolean;
  } = {},
): Promise<void> {
  const expectedEvents = options.expectedEvents ?? [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
  ];
  const expectedRowCount = options.expectedRowCount ?? 15;
  const expectedCountByEvent = options.expectedCountByEvent ?? {
    SessionStart: 2,
    UserPromptSubmit: 2,
    PreToolUse: 4,
  };
  const readTriggerTestId = () =>
    browser.execute(
      (marker: string, triggerPrefix: string) => {
        const turn = Array.from(document.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
          (candidate) => candidate.textContent?.includes(marker),
        );
        return (
          turn
            ?.querySelector<HTMLElement>(`[data-testid^="${triggerPrefix}-"]`)
            ?.getAttribute("data-testid") ?? null
        );
      },
      finalAssistantMarker,
      TID_V4_HOOK_DETAILS_TRIGGER,
    );
  await browser.waitUntil(async () => (await readTriggerTestId()) !== null, {
    timeout: 15000,
    timeoutMsg: "Completed full-chain turn did not expose the Hook action",
  });
  const triggerTestId = await readTriggerTestId();
  if (!triggerTestId) throw new Error("Missing full-chain Hook details trigger");
  const triggerSelector = `[data-testid="${triggerTestId}"]`;
  // Conflict merging once rendered both the ordinary action bar and the Hook-only fallback bar; taking only the first entry would miss the regression.
  expect(await $$(triggerSelector).length).toBe(1);
  const trigger = await $(triggerSelector);
  await trigger.scrollIntoView({ block: "center", inline: "nearest" });
  await trigger.moveTo();
  await mkdir(HOOK_BLOCK_SCREENSHOT_DIR, { recursive: true });
  await browser.saveScreenshot(
    join(HOOK_BLOCK_SCREENSHOT_DIR, `${finalAssistantMarker}-single-hook-action.png`),
  );
  expect(await trigger.getAttribute("aria-label")).toBe("Hooks");
  await trigger.click();

  const detailsSelector = `[data-testid^="${TID_V4_HOOK_DETAILS_CONTENT}-"]`;
  const details = await $(detailsSelector);
  await details.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: "Hook action did not open the details Popover",
  });
  await browser.saveScreenshot(
    join(HOOK_BLOCK_SCREENSHOT_DIR, `${finalAssistantMarker}-hook-details.png`),
  );
  const text = await details.getText();
  expect(text).toContain("Hooks");
  for (const event of expectedEvents) {
    expect(text).toContain(event);
  }
  expect(text).toContain("User");
  expect(text).not.toContain("node");
  expect(text).not.toContain(".mjs");
  expect(text).not.toContain("Write");
  expect(text).not.toContain("Read");
  expect(text).not.toContain("×");
  expect(text).not.toContain("已完成");
  expect(text).toMatch(/\b\d+(?:\.\d+)?(?:ms|s)\b/);
  const detailRows = await details.$$("li");
  const detailRowTexts = await detailRows.map((row) => row.getText());
  expect(detailRowTexts).toHaveLength(expectedRowCount);
  for (const [event, count] of Object.entries(expectedCountByEvent)) {
    expect(detailRowTexts.filter((row) => row.includes(event))).toHaveLength(count);
  }
  const listSelector = `${detailsSelector} ul`;
  if (options.skipOverflowAssertions === true) {
    // When the row count is too small to overflow (e.g. HK17's 5-row summary), skip the HK15 scroll visual assertion
    // and keep only the viewport bounds check.
    const bounds = await browser.execute((selector) => {
      const content = document.querySelector<HTMLElement>(selector);
      if (!content) throw new Error("Missing Hook details content");
      const rect = content.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      };
    }, detailsSelector);
    expect(bounds.top).toBeGreaterThanOrEqual(8);
    expect(bounds.left).toBeGreaterThanOrEqual(8);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 8);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 8);
    return;
  }
  const scrollBefore = await browser.execute((selector) => {
    const list = document.querySelector<HTMLElement>(selector);
    if (!list) throw new Error("Missing Hook details list");
    return {
      clientHeight: list.clientHeight,
      overflowY: getComputedStyle(list).overflowY,
      scrollHeight: list.scrollHeight,
    };
  }, listSelector);
  expect(scrollBefore.scrollHeight).toBeGreaterThan(scrollBefore.clientHeight);
  expect(scrollBefore.overflowY).toBe("auto");
  await browser.execute((selector) => {
    const list = document.querySelector<HTMLElement>(selector);
    if (!list) throw new Error("Missing Hook details list");
    list.scrollTop = list.scrollHeight;
  }, listSelector);
  await browser.waitUntil(
    async () =>
      browser.execute((selector) => {
        const list = document.querySelector<HTMLElement>(selector);
        const last = list?.querySelector<HTMLElement>("li:last-child");
        if (!list || !last) return false;
        const listRect = list.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        return lastRect.top >= listRect.top && lastRect.bottom <= listRect.bottom + 1;
      }, listSelector),
    { timeout: 5000, timeoutMsg: "Hook details list did not reveal its final row after scroll" },
  );
  const visibleLastRowText = await browser.execute((selector) => {
    const list = document.querySelector<HTMLElement>(selector);
    return list?.querySelector<HTMLElement>("li:last-child")?.innerText ?? null;
  }, listSelector);
  expect(visibleLastRowText).toBe(detailRowTexts.at(-1));
  const bounds = await browser.execute((selector) => {
    const content = document.querySelector<HTMLElement>(selector);
    if (!content) throw new Error("Missing Hook details content");
    const rect = content.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  }, detailsSelector);
  expect(bounds.top).toBeGreaterThanOrEqual(8);
  expect(bounds.left).toBeGreaterThanOrEqual(8);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 8);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 8);
}

function assertFullChainTrace(trace: HookTraceRecord[], prompt: string): void {
  const processTrace = processHookRecords(trace);
  expect(processTrace.map((record) => record.hook_event_name)).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreToolUse",
    "PostToolUseFailure",
    "Stop",
  ]);
  assertClaudeCompatibleTrace(processTrace);
  expect(
    hasHookRecord(trace, {
      executor: "command-sync",
      hook_event_name: "SessionStart",
      phase: "completed",
    }),
  ).toBe(true);
  expect(
    hasHookRecord(trace, {
      executor: "command-async",
      hook_event_name: "UserPromptSubmit",
      phase: "started",
    }),
  ).toBe(true);

  const session = findHookEvent(processTrace, "SessionStart");
  expect(session).toMatchObject({
    model: expect.any(String),
    source: "startup",
  });
  const userPrompt = findHookEvent(processTrace, "UserPromptSubmit");
  expect(userPrompt).toMatchObject({ prompt });
  expect(userPrompt.transcript_text).toContain(prompt);

  const preWrite = findToolHook(processTrace, "PreToolUse", HOOKS_TOOL_CALL_IDS.fullWrite);
  const permission = findToolHook(processTrace, "PermissionRequest", HOOKS_TOOL_CALL_IDS.fullWrite);
  const post = findToolHook(processTrace, "PostToolUse", HOOKS_TOOL_CALL_IDS.fullWrite);
  expect(preWrite.tool_input).toMatchObject({
    file_path: HOOKS_RELATIVE_PATHS.fullOriginal,
  });
  expect(permission.tool_input).toMatchObject({
    file_path: HOOKS_RELATIVE_PATHS.fullPreModified,
    content: "pretool modified content\n",
  });
  expect(post.tool_input).toMatchObject({
    file_path: HOOKS_RELATIVE_PATHS.fullFinal,
    content: "permission modified content\n",
  });
  expect(post.tool_response).toEqual(post.toolResponse);
  expect(post.tool_response).toEqual(expect.any(Object));
  expect(Object.prototype.hasOwnProperty.call(permission, "permission_suggestions")).toBe(false);

  const failure = findToolHook(processTrace, "PostToolUseFailure", HOOKS_TOOL_CALL_IDS.fullRead);
  expect(failure.error).toEqual(expect.any(String));
  expect(failure.error_details).toEqual(expect.any(Object));
  expect(failure.is_interrupt).toBe(false);
  const stop = findHookEvent(processTrace, "Stop");
  expect(stop).toMatchObject({
    last_assistant_message: HOOKS_FINAL_MARKERS.fullChain,
    stop_hook_active: false,
  });
  expect(stop.transcript_text).toContain(HOOKS_FINAL_MARKERS.fullChain);
}

function assertEarlyFailureTrace(trace: HookTraceRecord[]): void {
  const processTrace = processHookRecords(trace);
  expect(processTrace.map((record) => record.hook_event_name)).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PreToolUse",
    "PreToolUse",
    "PermissionRequest",
    "Stop",
  ]);
  assertClaudeCompatibleTrace(processTrace);
  expect(
    processTrace.filter((record) => record.hook_event_name === "PermissionRequest"),
  ).toHaveLength(1);
  expect(
    findToolHook(processTrace, "PermissionRequest", HOOKS_TOOL_CALL_IDS.earlyPermissionDeny)
      .tool_input,
  ).toMatchObject({ file_path: HOOKS_RELATIVE_PATHS.earlyPermissionDeny });
  expect(
    processTrace.some(
      (record) =>
        record.hook_event_name === "PostToolUse" || record.hook_event_name === "PostToolUseFailure",
    ),
  ).toBe(false);
}

function assertStopCapTrace(trace: HookTraceRecord[]): void {
  const processTrace = processHookRecords(trace);
  assertClaudeCompatibleTrace(processTrace);
  const stopRecords = processTrace.filter((record) => record.hook_event_name === "Stop");
  expect(stopRecords).toHaveLength(4);
  expect(stopRecords.map((record) => record.stop_hook_active)).toEqual([false, true, true, true]);
  expect(stopRecords.map((record) => record.last_assistant_message)).toEqual([
    STOP_STEP(0),
    STOP_STEP(1),
    STOP_STEP(2),
    STOP_STEP(3),
  ]);
  for (const [index, record] of stopRecords.entries()) {
    expect(record.transcript_text).toContain(STOP_STEP(index));
  }
}

function assertClaudeCompatibleTrace(records: HookTraceRecord[]): void {
  for (const record of records) {
    expect(record).toMatchObject({
      cwd: DEFAULT_WORKSPACE,
      hookEventName: expect.any(String),
      hook_event_name: expect.any(String),
      mode: expect.any(String),
      permission_mode: expect.any(String),
      sessionId: expect.any(String),
      session_id: expect.any(String),
      transcriptPath: expect.any(String),
      transcript_path: expect.any(String),
      transcript_readable: true,
      transcript_text: expect.any(String),
    });
    expect(record.hook_event_name).toBe(record.hookEventName);
    expect(record.permission_mode).toBe(record.mode);
    expect(record.session_id).toBe(record.sessionId);
    expect(record.transcript_path).toBe(record.transcriptPath);
    if ("toolName" in record) {
      expect(record.tool_name).toBe(record.toolName);
      expect(record.tool_input).toEqual(record.toolInput);
      expect(record.tool_use_id).toBe(record.toolCallId);
    }
  }
}

function findToolHook(
  records: HookTraceRecord[],
  event: string,
  toolCallId: string,
): HookTraceRecord {
  const record = records.find(
    (item) => item.hook_event_name === event && item.tool_use_id === toolCallId,
  );
  if (!record) throw new Error(`Missing ${event} hook for ${toolCallId}`);
  return record;
}

async function waitForIdle(timeoutMsg: string): Promise<void> {
  await waitForV4Pane(
    (snapshot) =>
      snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
    timeoutMsg,
    60000,
  );
}

async function waitForEmptyV4Composer(timeoutMsg: string): Promise<void> {
  try {
    await browser.waitUntil(async () => (await getV4ComposerText()) === "", {
      // A single Hook in this fixture is itself allowed 10 seconds; the same total limit must not be used to judge cross-process admission failure.
      // Still wait for a real clear — no sleep, and never clear the text on behalf of the product after a timeout.
      timeout: 60000,
      timeoutMsg,
    });
  } catch (error) {
    // A failed first send is not a Hook failure; attach the product error details so the bare "draft not cleared" record does not mask the upstream error.
    const details = await $(sel(TID_CHAT_ERROR_DETAILS_BUTTON));
    if (await details.isExisting()) {
      await details.click();
      await browser.waitUntil(async () => Boolean(await $("[role='dialog'] pre").getText()), {
        timeout: 3000,
      });
      const content = await $("[role='dialog'] pre").getText();
      throw new Error(`${timeoutMsg}; send error: ${content}`, { cause: error });
    }
    const text = await getV4ComposerText();
    throw new Error(`${timeoutMsg}; composer=${JSON.stringify(text)}`, { cause: error });
  }
}

async function expectMissingPath(relativePath: string): Promise<void> {
  await expect(readFile(workspacePath(relativePath), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
}

function workspacePath(relativePath: string): string {
  return join(DEFAULT_WORKSPACE, relativePath);
}
