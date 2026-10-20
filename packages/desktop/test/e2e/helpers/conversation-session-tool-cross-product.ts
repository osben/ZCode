import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2ERuntimePath } from "./e2e-runtime-paths.js";
import { getV4ConfigProjection, switchV4Mode } from "./v4-conversation.js";

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
  if ((await getV4ConfigProjection()).mode === "yolo") {
    return;
  }
  // Bug 根因：模式菜单已迁移为 DropdownMenu，旧 Select option 查询永远找不到 yolo。
  // 复用当前 V4 控件，并只以当前 composer 的模式投影确认，不读取其他工作区配置。
  await switchV4Mode("yolo");
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
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

interface ConfigOptionLike {
  category?: string;
  currentValue?: unknown;
  id?: string;
  type?: string;
}
