import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

interface OpenTaskDraftPayload {
  path: string;
  text: string;
}

interface OpenTaskDraftDeps {
  allowOpenWorkspace: boolean;
  openWorkspacePath: (workspacePath: string) => void | Promise<void>;
  activateTabByPath: (workspacePath: string) => boolean;
  startDraftInWorkspace: (workspacePath: string) => void;
  requestComposerTextInsert: (
    workspacePath: string,
    text: string,
    workspaceIdentity?: string,
    mention?: ComposerMentionPrefill,
    mode?: "replace" | "prepend-if-missing" | "prepend-text",
  ) => number;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

type OpenTaskDraftOutcome = "inserted" | "ignored" | "workspace-unavailable";

/**
 * `zcode://task/new` delivery order (see specs/deeplink-new-task.md):
 * open workspace -> confirm the tab exists in this window -> fresh draft -> insert text. The text is
 * only placed in the composer; sending stays an explicit user action.
 */
export async function applyOpenTaskDraft(
  payload: OpenTaskDraftPayload,
  deps: OpenTaskDraftDeps,
): Promise<OpenTaskDraftOutcome> {
  if (!deps.allowOpenWorkspace) {
    deps.logger.info("[Root] 当前模式不支持通过 deep link 打开任务草稿，已忽略请求");
    return "ignored";
  }

  deps.logger.info("[Root] onOpenTaskDraft", {
    path: payload.path,
    textLength: payload.text.length,
  });
  await deps.openWorkspacePath(payload.path);

  // openWorkspacePath hands the folder to another window when that window already has it open; in that
  // case this window has no tab and the insert would land in an invisible workspace state.
  if (!deps.activateTabByPath(payload.path)) {
    deps.logger.warn("[Root] task/new 目标工作区未在当前窗口打开，已放弃插入草稿", {
      path: payload.path,
    });
    return "workspace-unavailable";
  }

  deps.startDraftInWorkspace(payload.path);
  // prepend-text keeps any unsent composer text the user already has instead of replacing it.
  deps.requestComposerTextInsert(payload.path, payload.text, undefined, undefined, "prepend-text");
  return "inserted";
}
