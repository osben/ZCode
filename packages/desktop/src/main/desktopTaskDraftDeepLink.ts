import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Locale } from "@zcode/shared";

export const TASK_DRAFT_PROMPT_MAX_CHARS = 8_000;
export const TASK_DRAFT_FILE_MAX_BYTES = 256 * 1024;
export const TASK_DRAFT_PREVIEW_MAX_CHARS = 400;

export type TaskDraftRejectionReason =
  | "empty_prompt"
  | "prompt_too_long"
  | "file_unreadable"
  | "file_not_regular"
  | "file_outside_project"
  | "file_too_large"
  | "invalid_encoding";

export type TaskDraftTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: TaskDraftRejectionReason };

export interface ResolveTaskDraftTextInput {
  /** Already validated local project directory. */
  projectPath: string;
  prompt?: string;
  promptFile?: string;
}

function isInsideDirectory(directory: string, target: string): boolean {
  const rel = relative(directory, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function readPromptFile(
  projectPath: string,
  promptFile: string,
): Promise<TaskDraftTextResult> {
  if (!isAbsolute(promptFile) || promptFile.includes("\0")) {
    return { ok: false, reason: "file_unreadable" };
  }

  let realProject: string;
  let realFile: string;
  try {
    [realProject, realFile] = await Promise.all([realpath(projectPath), realpath(promptFile)]);
  } catch {
    return { ok: false, reason: "file_unreadable" };
  }

  // Compare real paths so a symlink inside the project cannot smuggle in a file from outside it.
  if (!isInsideDirectory(realProject, realFile)) {
    return { ok: false, reason: "file_outside_project" };
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    // Open the resolved path and stat the handle, so the file we checked is the file we read.
    handle = await open(realFile, constants.O_RDONLY);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { ok: false, reason: "file_not_regular" };
    }
    if (stats.size > TASK_DRAFT_FILE_MAX_BYTES) {
      return { ok: false, reason: "file_too_large" };
    }

    const buffer = Buffer.alloc(Math.min(stats.size, TASK_DRAFT_FILE_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    try {
      return {
        ok: true,
        text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      };
    } catch {
      return { ok: false, reason: "invalid_encoding" };
    }
  } catch {
    return { ok: false, reason: "file_unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Resolve the task text from an inline prompt or a promptFile; rejects blank or over-limit text. */
export async function resolveTaskDraftText(
  input: ResolveTaskDraftTextInput,
): Promise<TaskDraftTextResult> {
  let result: TaskDraftTextResult;
  if (input.promptFile !== undefined) {
    result = await readPromptFile(input.projectPath, input.promptFile);
  } else {
    result = { ok: true, text: input.prompt ?? "" };
  }

  if (!result.ok) {
    return result;
  }
  if (result.text.trim() === "") {
    return { ok: false, reason: "empty_prompt" };
  }
  if (result.text.length > TASK_DRAFT_PROMPT_MAX_CHARS) {
    return { ok: false, reason: "prompt_too_long" };
  }
  return result;
}

export function buildTaskDraftPreview(text: string): string {
  return text.length > TASK_DRAFT_PREVIEW_MAX_CHARS
    ? `${text.slice(0, TASK_DRAFT_PREVIEW_MAX_CHARS)}…`
    : text;
}

export interface TaskDraftDialogCopy {
  buttons: [string, string];
  title: string;
  message: string;
  detail: (path: string, preview: string) => string;
}

// A complete Record<Locale, ...> so adding a language requires copy at compile time.
const TASK_DRAFT_DIALOG_COPY: Record<Locale, TaskDraftDialogCopy> = {
  "zh-CN": {
    buttons: ["打开并填入草稿", "取消"],
    title: "打开外部 ZCode 链接？",
    message: "是否在 ZCode 中打开此文件夹，并把下面的任务填入新草稿？（不会自动发送）",
    detail: (path, preview) =>
      `${path}\n\n${preview}\n\n只打开你信任来源的链接。项目设置可能影响 agent runtime。`,
  },
  "en-US": {
    buttons: ["Open and fill draft", "Cancel"],
    title: "Open external ZCode link?",
    message:
      "Open this folder in ZCode and put the task below into a new draft? (Nothing is sent.)",
    detail: (path, preview) =>
      `${path}\n\n${preview}\n\nOnly open links from sources you trust. Project settings may affect the agent runtime.`,
  },
  "uk-UA": {
    buttons: ["Відкрити й заповнити чернетку", "Скасувати"],
    title: "Відкрити зовнішнє посилання ZCode?",
    message:
      "Відкрити цю папку в ZCode і додати завдання нижче до нової чернетки? (Нічого не надсилається.)",
    detail: (path, preview) =>
      `${path}\n\n${preview}\n\nВідкривайте лише посилання з джерел, яким довіряєте. Налаштування проєкту можуть впливати на agent runtime.`,
  },
};

export function resolveTaskDraftDialogCopy(locale: Locale): TaskDraftDialogCopy {
  return TASK_DRAFT_DIALOG_COPY[locale] ?? TASK_DRAFT_DIALOG_COPY["en-US"];
}
