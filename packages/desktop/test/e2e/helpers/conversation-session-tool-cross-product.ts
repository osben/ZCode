import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2ERuntimePath } from "./e2e-runtime-paths.js";
import { switchV4Mode } from "./v4-conversation.js";

export const TOOL_CROSS_PRODUCT_ROOT = resolveE2ERuntimePath(
  "conversation-session-tool-cross-product",
);
export const TOOL_CROSS_PRODUCT_MARKER_PREFIX = "E2E_TOOL_CROSS_PRODUCT";
export const TOOL_CROSS_PRODUCT_READ_FILE = join(TOOL_CROSS_PRODUCT_ROOT, "read-fixture.txt");
export const TOOL_CROSS_PRODUCT_GLOB_FILE = join(TOOL_CROSS_PRODUCT_ROOT, "glob-fixture.e2e");
export const TOOL_CROSS_PRODUCT_GREP_FILE = join(TOOL_CROSS_PRODUCT_ROOT, "grep-fixture.txt");

export type ToolCrossProductScenario = "compact" | "fork" | "goal";

export interface ToolCrossProductCase {
  markerName: string;
  toolName: string;
  historyAssertion?: "visibleToolBlock" | "providerRequest";
  providerHistoryMarker?: string;
}

export const TOOL_CROSS_PRODUCT_CASES: ToolCrossProductCase[] = [
  { markerName: "READ", toolName: "Read" },
  { markerName: "WRITE", toolName: "Write" },
  { markerName: "EDIT", toolName: "Edit" },
  { markerName: "BASH", toolName: "Bash" },
  { markerName: "GLOB", toolName: "Glob" },
  { markerName: "GREP", toolName: "Grep" },
  { markerName: "WEBFETCH", toolName: "WebFetch" },
  {
    markerName: "TODO_READ",
    toolName: "TodoRead",
    historyAssertion: "providerRequest",
    providerHistoryMarker: "toolu_e2e_tool_cross_product_todo_read",
  },
  { markerName: "TODO_WRITE", toolName: "TodoWrite" },
  { markerName: "GOAL_READ", toolName: "GoalRead" },
  {
    markerName: "ENTER_PLAN_MODE",
    toolName: "EnterPlanMode",
    historyAssertion: "providerRequest",
    providerHistoryMarker: "toolu_e2e_tool_cross_product_enter_plan_mode",
  },
  { markerName: "EXIT_PLAN_MODE", toolName: "ExitPlanMode" },
  { markerName: "ASK_USER_QUESTION", toolName: "AskUserQuestion" },
  { markerName: "READ_SESSION_CONTEXT", toolName: "ReadSessionContext" },
  { markerName: "SEND_MESSAGE", toolName: "SendMessage" },
  { markerName: "AGENT", toolName: "Agent" },
  { markerName: "SKILL", toolName: "Skill" },
  // Reason for the change: the current desktop E2E agent runtime does not register the Workflow tool.
  // If the replay fixture forcibly calls Workflow it deterministically gets "Tool not found", so the later compact/fork/goal
  // assertions would verify the failed tool card instead of tool history capability; cut it from the formal cross-product set.
];

export function markerForToolCase(toolCase: ToolCrossProductCase) {
  return `${TOOL_CROSS_PRODUCT_MARKER_PREFIX}_${toolCase.markerName}`;
}

export function buildToolCrossProductPrompt(
  toolCase: ToolCrossProductCase,
  scenario: ToolCrossProductScenario,
  runId: string,
) {
  return [
    `${markerForToolCase(toolCase)}_${scenario.toUpperCase()}_${runId}:`,
    `Trigger the ${toolCase.toolName} tool exactly once.`,
    'Then reply with exactly "upstream-e2e-ok" and no other text.',
  ].join(" ");
}

export async function prepareToolCrossProductFixtures() {
  await cleanupToolCrossProductFixtures();
  await mkdir(TOOL_CROSS_PRODUCT_ROOT, { recursive: true });
  await writeFile(
    TOOL_CROSS_PRODUCT_READ_FILE,
    [
      "E2E_TOOL_RESULT_READ",
      "E2E_TOOL_RESULT_GREP",
      "This file is read by the conversation tool cross product e2e.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(TOOL_CROSS_PRODUCT_GLOB_FILE, "E2E_TOOL_RESULT_GLOB\n", "utf-8");
  await writeFile(
    TOOL_CROSS_PRODUCT_GREP_FILE,
    "E2E_TOOL_RESULT_GREP content search fixture\n",
    "utf-8",
  );
}

export async function cleanupToolCrossProductFixtures() {
  await rm(TOOL_CROSS_PRODUCT_ROOT, { recursive: true, force: true });
}

export async function ensureToolCrossProductFullAccessMode() {
  if (await isFullAccessModeSelected()) {
    return;
  }
  // The old aria-label trigger path left the wait's condition body without a single completed
  // evaluation under WDIO v9 and reported "not-started" for every case. Reuse the canonical
  // testid-based composer mode switch (same path as switchV4Mode callers) instead.
  await switchV4Mode("yolo");
  await browser.waitUntil(async () => isFullAccessModeSelected(), {
    timeout: 30000,
    timeoutMsg: "工具叉乘 e2e 没有切换到 Full access/yolo mode",
  });
}

export async function respondToToolCrossProductBlockers() {
  const result = (await browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const clickFirstPermissionOption = () => {
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (element) => {
          const label = normalizeText(element.getAttribute("aria-label"));
          return label === "Permission required" || label === "需要权限";
        },
      );
      const option = listbox?.querySelector<HTMLButtonElement>('button[role="option"]');
      option?.click();
      return Boolean(option);
    };
    const clickFirstQuestionOption = () => {
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (element) =>
          normalizeText(element.getAttribute("aria-label")).includes(
            "E2E_TOOL_CROSS_PRODUCT_ASK_USER_QUESTION",
          ),
      );
      const option = listbox?.querySelector<HTMLButtonElement>('button[role="option"]');
      option?.click();
      return Boolean(option);
    };

    const clickPlanApprovalSubmit = () => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
      const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
      const footer = document.querySelector<HTMLElement>('[data-elicitation-dialog-footer="true"]');
      const hasApproveOption = Array.from(
        body?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
      ).some((button) =>
        ["Approve", "批准"].some((label) => normalizeText(button.textContent).includes(label)),
      );
      const submit = Array.from(footer?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (button) => ["Submit", "提交"].includes(normalizeText(button.textContent)),
      );
      if (!hasApproveOption || !submit || submit.disabled) {
        return false;
      }
      submit.click();
      return true;
    };

    return {
      elicitationClicked: clickFirstQuestionOption(),
      planApprovalClicked: clickPlanApprovalSubmit(),
      permissionClicked: clickFirstPermissionOption(),
    };
  })) as {
    elicitationClicked: boolean;
    planApprovalClicked: boolean;
    permissionClicked: boolean;
  };

  if (result.elicitationClicked || result.planApprovalClicked || result.permissionClicked) {
    // Bug root cause: in V4 ExitPlanMode goes through a separate plan approval dialog, no longer the legacy
    // PermissionDialog; clicking only the permission option leaves the whole turn stuck in interaction forever.
    await browser.pause(250);
  }
  return result;
}

async function isFullAccessModeSelected() {
  const result = (await browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const store = (
      window as typeof window & {
        __zcodeSessionStoreE2E?: {
          getState?: () => {
            workspaces?: Record<
              string,
              {
                activeTaskId?: string | null;
                configOptions?: Array<ConfigOptionLike> | null;
                taskConfigOptionsByTaskId?: Record<string, Array<ConfigOptionLike>>;
              }
            >;
          };
        };
      }
    ).__zcodeSessionStoreE2E;
    const workspaceValues: string[] = [];
    const activeTaskValues: string[] = [];
    const collect = (options: Array<ConfigOptionLike> | null | undefined, target: string[]) => {
      for (const option of options ?? []) {
        if (
          option.type === "select" &&
          (option.category === "mode" || option.id === "mode") &&
          typeof option.currentValue === "string"
        ) {
          target.push(option.currentValue);
        }
      }
    };
    for (const workspace of Object.values(store?.getState?.().workspaces ?? {})) {
      collect(workspace.configOptions, workspaceValues);
      const activeTaskId = workspace.activeTaskId;
      if (activeTaskId) {
        collect(workspace.taskConfigOptionsByTaskId?.[activeTaskId], activeTaskValues);
      }
    }

    const labels = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button[aria-label="Switch mode"],button[aria-label="切换模式"]',
      ),
    )
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => normalizeText(element.textContent));
    const labelShowsYolo = labels.some((label) =>
      ["Full access", "完全访问", "Yolo", "全自动模式"].some((expected) =>
        label.includes(expected),
      ),
    );

    return {
      activeTaskValues,
      labels,
      workspaceValues,
      // Bug root cause: after EnterPlanMode the workspace default is still yolo, but the active task is already plan;
      // the old logic aggregated the values and misjudged as soon as it saw any yolo. The visible V4 trigger is the authoritative value for the current pane;
      // only when the DOM is unavailable do we degrade by priority: active task → workspace default.
      yolo:
        labels.length > 0
          ? labelShowsYolo
          : activeTaskValues.length > 0
            ? activeTaskValues.includes("yolo")
            : workspaceValues.includes("yolo"),
    };
  })) as {
    activeTaskValues: string[];
    labels: string[];
    workspaceValues: string[];
    yolo: boolean;
  };

  return result.yolo;
}

interface ConfigOptionLike {
  category?: string;
  currentValue?: unknown;
  id?: string;
  type?: string;
}
