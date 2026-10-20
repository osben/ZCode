// Prefill text for "Create via chat / Revise in chat" in the hub.
// These are ordinary user messages: prefill the draft without sending, so the user can continue writing what to change/create.
// The "Promote to global" text (buildSavedWorkflowPromotePrompt) is an exception: as createSession.firstInput it is
// **sent automatically**, so it must be a complete instruction rather than a starter.

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

function isUk(locale: string): boolean {
  return locale.toLowerCase().startsWith("uk");
}

/** "Revise in chat": prefill only, do not send; the user continues by writing what to change. */
export function buildSavedWorkflowRevisePrompt(input: {
  name: string;
  path: string;
  locale: string;
  scope?: "project" | "global";
}): string {
  // When revising a global workflow, append "keep scope: \"global\"" so the model saves the replacement at the same scope.
  const globalReminderZh =
    input.scope === "global" ? '它是全局工作流，保存时保持 scope: "global"。' : "";
  const globalReminderEn =
    input.scope === "global" ? 'It is a global workflow; keep scope: "global" when saving. ' : "";
  if (isUk(input.locale)) {
    const globalReminderUk =
      input.scope === "global"
        ? 'Це глобальний робочий процес; під час збереження залиш scope: "global". '
        : "";
    return `Доопрацюй збережений робочий процес «${input.name}» (${input.path}): ${globalReminderUk}`;
  }
  return isZh(input.locale)
    ? `请修订已保存的工作流「${input.name}」（${input.path}）：${globalReminderZh}`
    : `Please revise the saved workflow "${input.name}" (${input.path}): ${globalReminderEn}`;
}

/** Empty state / header "Create through conversation": prefill an opening prompt. */
export function buildSavedWorkflowCreatePrompt(
  locale: string,
  scope?: "project" | "global",
): string {
  if (isUk(locale)) {
    return scope === "global"
      ? 'Допоможи спроєктувати робочий процес і, коли він запрацює, збережи його через SaveWorkflow як глобальний (scope: "global"): '
      : "Допоможи спроєктувати робочий процес і, коли він запрацює, збережи його в цьому проєкті: ";
  }
  if (scope === "global") {
    return isZh(locale)
      ? '帮我设计一个工作流，跑通后用 SaveWorkflow 保存为全局工作流（scope: "global"）：'
      : 'Help me design a workflow and save it as a global workflow (scope: "global") with SaveWorkflow once it works: ';
  }
  return isZh(locale)
    ? "帮我设计一个工作流，跑通后保存到本项目："
    : "Help me design a workflow and save it to this project once it works: ";
}

/**
 * "Promote to global": summarize a project workflow as a complete instruction for a global workflow (sent automatically, not a prefilled opening).
 *
 * Provide only the name and path; the model reads the file. The checklist is user-approved: read → find repository-specific references → extract them as args or neutral
 * wording → preserve the causal structure → SaveWorkflow(scope: "global", name may be changed) → summarize; decline if it is inherently tied to the project.
 * Explicitly say "do not modify the original file": both copies coexist, and the user may delete either one (invariant 9).
 */
export function buildSavedWorkflowPromotePrompt(input: {
  name: string;
  path: string;
  locale: string;
}): string {
  if (isZh(input.locale)) {
    return [
      `请把已保存的项目工作流「${input.name}」（${input.path}）提升为全局工作流。全局工作流对所有项目可见、在任何项目里都能运行，所以它不能依赖本仓库的任何东西。请按下面的步骤做：`,
      "1. 读取这个文件，理解它的因果结构（哪些子代理、什么顺序、什么交接）。",
      "2. 找出所有引用本仓库的地方：具体路径、命令、目录结构、命名约定、分支名等。",
      "3. 把它们抽成 `args` 声明（带说明与合理默认值），或改成不依赖项目的中性表述；保持因果结构不变。",
      '4. 用 SaveWorkflow 以 scope: "global" 保存。名字可以沿用，也可以取一个更贴切的名字。不要改动原来的项目工作流文件。',
      "5. 最后用几句话总结你概括了什么、哪些点被抽成了参数。",
      "如果这个工作流本质上就绑定在这个项目上、无法有意义地概括，请说明原因并停下，不要保存。",
    ].join("\n");
  }
  if (isUk(input.locale)) {
    return [
      `Перетвори збережений робочий процес проєкту «${input.name}» (${input.path}) на глобальний. Глобальні робочі процеси видно в усіх проєктах і їх можна запускати з будь-якого з них, тому він не повинен залежати ні від чого в цьому репозиторії. Виконай такі кроки:`,
      "1. Прочитай файл і зрозумій його причинно-наслідкову структуру (які субагенти, в якому порядку, як передають роботу).",
      "2. Знайди все, що посилається на цей репозиторій: конкретні шляхи, команди, структуру каталогів, правила іменування, назви гілок тощо.",
      "3. Винеси це в оголошення `args` (з описами й розумними значеннями за замовчуванням) або переформулюй нейтрально щодо проєкту, зберігши причинно-наслідкову структуру.",
      '4. Збережи його через SaveWorkflow із scope: "global". Назву можна залишити або вибрати точнішу. Не змінюй початковий файл робочого процесу проєкту.',
      "5. Наприкінці коротко підсумуй, що саме узагальнено і які пункти стали аргументами.",
      "Якщо робочий процес за своєю суттю прив'язаний до цього проєкту й узагальнити його осмислено не можна, поясни чому й зупинись, нічого не зберігаючи.",
    ].join("\n");
  }
  return [
    `Promote the saved project workflow "${input.name}" (${input.path}) to a global workflow. Global workflows are visible to every project and can run from any of them, so it must not depend on anything in this repository. Follow these steps:`,
    "1. Read the file and understand its causal structure (which subagents, in what order, with what hand-offs).",
    "2. Find everything that refers to this repository: concrete paths, commands, directory layout, naming conventions, branch names, and so on.",
    "3. Lift those into `args` declarations (with descriptions and sensible defaults) or rewrite them in project-neutral terms, keeping the causal structure intact.",
    '4. Save it with SaveWorkflow using scope: "global". Keep the name or pick a better one. Do not modify the original project workflow file.',
    "5. Finish with a short summary of what you generalized and which points became arguments.",
    "If the workflow is inherently bound to this project and cannot be generalized meaningfully, say why and stop without saving.",
  ].join("\n");
}
