// Pure logic for the completion card's "save / run again" (docs/dynamic-workflow/transcript-and-notifications.md,
// "Saving the run, and running it again"): name rules, landing preview, and the message handed to ZCode.
//
// Same reason as globalWorkflowGroupHelpers for splitting from components: these judgments have no
// React and should be testable on their own.
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";

/**
 * The name's legal shape, **character-for-character identical** to the agent side's
 * `isValidSavedWorkflowName` (@zcode/contracts). Writing it again here is not duplication but a
 * **forward echo**: the user must know after every keystroke whether the name can be a file name, and
 * the rule itself (charset + length + not `.` / `..`) is the path-traversal defense — neither side
 * may loosen it. The real verdict stays with the agent: this only makes things clear before the click.
 */
const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
export const SAVED_WORKFLOW_NAME_MAX_CHARS = 64;

export function isValidSavedWorkflowNameText(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_NAME_MAX_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  return name.replaceAll(".", "").length > 0;
}

/**
 * Landing preview. Project scope writes a relative path (exactly what the user sees in their own
 * repo); global scope writes a `~`-prefixed home path — the **agent machine's** home, which is why
 * remote projects are not offered the global scope at all.
 */
export function savedWorkflowPathPreview(scope: ZCodeSavedWorkflowScope, name: string): string {
  const file = `${name}.dwf.ts`;
  return scope === "global" ? `~/.zcode/workflows/${file}` : `.zcode/workflows/${file}`;
}

export interface WorkflowSaveDraft {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  description: string;
}

/**
 * The draft at the moment the popover opens.
 *
 * The name is pre-filled only when the run name **itself** satisfies the file-name rule: a run name is
 * a label the model wrote in the user's language ("PR layered review · security / performance /
 * architecture"); stuffing it into the name field would only yield a value guaranteed to error. The
 * description, conversely, is pre-filled with the run name — it is precisely the one-sentence "what
 * this workflow does" that the hub card asks for.
 */
export function initialWorkflowSaveDraft(input: {
  runName?: string;
  scope?: ZCodeSavedWorkflowScope;
}): WorkflowSaveDraft {
  const runName = input.runName?.trim() ?? "";
  return {
    name: isValidSavedWorkflowNameText(runName) ? runName : "",
    scope: input.scope ?? "project",
    description: runName,
  };
}

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

/**
 * The user message sent by "let ZCode distill and save it" (docs/dynamic-workflow/transcript-and-notifications.md,
 * "The message the lead sends"). Same precedent as the hub's "promote to global": the GUI writes it,
 * it is sent automatically, and the user is not asked again.
 *
 * Three things must be in the message: **distill**, not copy verbatim (otherwise this path is no
 * different from "save as-is"), the fields the user already filled in, and `run_id` — the **only**
 * persistent link between this run and the definition the model saves under its own name
 * (launch.md "`SaveWorkflow`"). The script does not go into the message: the model already holds the
 * call that started this run.
 */
export function buildWorkflowSaveRequestPrompt(input: {
  locale: string;
  runId: string;
  runName?: string;
  name: string;
  scope: ZCodeSavedWorkflowScope;
  description: string;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  const runName = input.runName?.trim();
  if (isZh(input.locale)) {
    const target =
      input.scope === "global" ? '保存为全局工作流（scope: "global"）' : "保存到本项目";
    return [
      `请把刚跑完的工作流${runName ? `「${runName}」` : ""}提炼成可以复用的工作流，用 SaveWorkflow ${target}：`,
      "1. 脚本以这次运行实际执行的那一份为准，不要改动它的逻辑。",
      "2. 把两次运行之间会变化的值抽成 args（写好说明与合理默认值），并补齐 description 与 whenToUse。",
      name.length > 0 ? `3. 名字用 \`${name}\`。` : "3. 名字请你来取（只能用字母、数字和 - _ .）。",
      description.length > 0 ? `4. 说明可以参考：${description}` : "",
      `5. 调用 SaveWorkflow 时带上 run_id: "${input.runId}"——这次运行要据此认出自己已被保存。`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  const target =
    input.scope === "global"
      ? 'save it as a global workflow (scope: "global")'
      : "save it to this project";
  return [
    `Please distill the workflow that just finished${runName ? ` ("${runName}")` : ""} into a reusable one and ${target} with SaveWorkflow:`,
    "1. Use the script this run actually executed; do not change its logic.",
    "2. Lift the values that change between runs into args (with descriptions and sensible defaults), and write description and whenToUse.",
    name.length > 0
      ? `3. Name it \`${name}\`.`
      : "3. Pick the name yourself (letters, digits and - _ . only).",
    description.length > 0 ? `4. For the description, start from: ${description}` : "",
    `5. Pass run_id: "${input.runId}" to SaveWorkflow, so that run can tell it has been saved.`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
