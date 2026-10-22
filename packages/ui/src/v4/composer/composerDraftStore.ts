// composer parity：v4 composer 的 per-session 草稿持久化（新做，轻量 localStorage）。
//
// 旧草稿面（zcodeSessionStore composerDraftByScopeId + chatComposerDraftStorage 写路径）
// 已随 store 收尾删除；本模块是 v4 侧替代——键空间独立（v4 前缀），不与旧键互写，
// 旧键清理仍归 chatComposerDraftStorage 的 janitor。
// 语义：scope = sessionId（draft 态 = "__draft__"）；保存 text + editorStateJson，外部预填在
// Lexical 尚未挂载时额外保存 mention（保证重挂载不降级为纯文本）。
// 仅有非空白正文才持久化；mode/modelSelection 随正文保存，删空后删除整个 scope。
// 附件不入草稿（objectUrl/File 不可序列化，localPath 附件重启后归属难校验——
// 与「v4 composer 不做附件草稿持久化」的裁决一致）。
import { logger } from "@/logger.js";
import {
  modelSelectionSchema,
  incognitoProfileSchema,
  type IncognitoProfile,
  remoteHostIdFromWorkspaceIdentity,
  type ModelSelection,
} from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";
import type { CodeCommentComposerAttachment } from "@/lib/codeCommentContext.js";
import type { PptxElementReference } from "@/lib/pptxElementReference.js";
import type { WebElementContextComposerAttachment } from "@/lib/webElementContext.js";
import type { PluginUiModelContext } from "@/plugin-ui/domain/pluginUiModelContext.js";
import {
  readRecoveryAttachment,
  readWorktreeIntent,
  type V4ComposerRecoveryAttachment,
  type V4ComposerWorktreeIntent,
} from "./composerRecoveryRecord.js";

/** Non-text context that must survive a worktree recovery round trip. */
export interface V4ComposerRecoveryContexts {
  conversationQuotes?: ConversationSelectionReference[];
  codeComments?: CodeCommentComposerAttachment[];
  webElements?: WebElementContextComposerAttachment[];
  pptxElements?: PptxElementReference[];
  pluginUiContexts?: PluginUiModelContext[];
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
}

export interface V4ComposerDraft {
  text: string;
  /** 未提交草稿的组织意图；真实任务归属始终由 Host 管理。 */
  projectId?: string | null;
  taskGroupId?: string | null;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  /** 有合法 mode 表示已经初始化；没有模型仍是明确空态，不能按旧文本草稿补默认。 */
  mode?: SubmissionMode;
  planEnabled?: boolean;
  modelSelection?: ModelSelection;
  /**
   * Existing-session only: the user explicitly picked `modelSelection` in this Session's composer.
   * This marker alone keeps an empty-text record; it is cleared when the picked model is accepted.
   */
  modelSelectionPicked?: true;
  /** 首次分享导入等待公共新任务初始化；不能由空 Session snapshot 抢先填充。 */
  initializeFromNewTask?: true;
  recoveryAttachments?: V4ComposerRecoveryAttachment[];
  recoveryContexts?: V4ComposerRecoveryContexts;
  worktreeIntent?: V4ComposerWorktreeIntent;
  /** Unaccepted first input; authoritative conversation rows remain owned by the CLI. */
  firstSubmission?: {
    submissionId: string;
    ownerKey: string;
    generation?: number;
    status: "preparing" | "sending" | "failed" | "unknown";
    commandId?: string;
    reservation?: { sessionId: string; commandId: string };
    incognito?: IncognitoProfile;
  };
  updatedAt: number;
}

interface V4DraftFile {
  version: 1;
  legacyClaimed?: boolean;
  scopes: Record<string, V4ComposerDraft>;
}

const STORAGE_KEY_PREFIX = "zcode-v4-composer-drafts:v1:";
export interface ComposerScope {
  clientNamespace: string;
  hostId: string;
  projectId: string | null;
}

export function composerScopeKey(scope: ComposerScope): string {
  return JSON.stringify([scope.clientNamespace, scope.hostId, scope.projectId]);
}

export interface PendingTaskDraft {
  draftId: string;
  workspacePath?: string;
  commandId?: string;
  sessionId?: string | null;
}

function pendingTaskKey(scope: ComposerScope): string {
  return `zcode-pending-task-draft:v1:${composerScopeKey(scope)}`;
}
export function readPendingTaskDraft(scope: ComposerScope): PendingTaskDraft | null {
  try {
    const raw = getStorage()?.getItem(pendingTaskKey(scope));
    const value = raw ? JSON.parse(raw) : null;
    return value &&
      typeof value.draftId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.draftId) &&
      (value.workspacePath === undefined || typeof value.workspacePath === "string") &&
      (value.commandId === undefined || typeof value.commandId === "string") &&
      (value.sessionId == null || typeof value.sessionId === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}
function writePendingTaskDraft(scope: ComposerScope, value: PendingTaskDraft | null): void {
  const storage = getStorage();
  // 未保存身份时不得先分配目录，否则刷新又会失去草稿入口。
  if (!storage) throw new Error("composer.draft-storage-unavailable");
  if (value) storage.setItem(pendingTaskKey(scope), JSON.stringify(value));
  else storage.removeItem(pendingTaskKey(scope));
}
export function ensurePendingTaskDraft(scope: ComposerScope): PendingTaskDraft {
  const current = readPendingTaskDraft(scope);
  if (current) return current;
  const next = { draftId: crypto.randomUUID() };
  writePendingTaskDraft(scope, next);
  return next;
}
export function bindPendingTaskDraft(
  scope: ComposerScope,
  draftId: string,
  workspacePath: string,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId === draftId && current.workspacePath !== workspacePath)
    writePendingTaskDraft(scope, { ...current, workspacePath });
}
export function completePendingTaskDraft(scope: ComposerScope, draftId: string): void {
  if (readPendingTaskDraft(scope)?.draftId === draftId) writePendingTaskDraft(scope, null);
}
export function markPendingTaskDraftCommand(
  scope: ComposerScope,
  draftId: string,
  commandId: string,
  sessionId: string | null,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId !== draftId) return;
  if (current.commandId && current.commandId !== commandId)
    throw new Error("composer.draft-submission-pending");
  writePendingTaskDraft(scope, { ...current, commandId, sessionId });
}
export function releasePendingTaskDraftCommand(
  scope: ComposerScope,
  draftId: string,
  commandId: string,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId !== draftId || current.commandId !== commandId) return;
  writePendingTaskDraft(scope, { draftId, workspacePath: current.workspacePath });
}

export function resolveComposerScope(
  projectId: string | null | undefined,
  workspaceIdentity?: string,
  clientNamespace = "desktop",
): ComposerScope {
  return {
    clientNamespace,
    hostId: workspaceIdentity
      ? (remoteHostIdFromWorkspaceIdentity(workspaceIdentity) ?? workspaceIdentity)
      : "local",
    projectId: projectId ?? null,
  };
}

function workspaceScopeKey(
  path: string,
  identity: string | undefined,
  clientNamespace: string,
): string {
  return `zcode-composer-workspace-scope:v1:${JSON.stringify([clientNamespace, identity?.trim() || path])}`;
}
export function rememberComposerWorkspaceScope(
  path: string,
  identity: string | undefined,
  scope: ComposerScope,
): void {
  try {
    getStorage()?.setItem(
      workspaceScopeKey(path, identity, scope.clientNamespace),
      JSON.stringify(scope),
    );
  } catch (error) {
    warnStorageFailure(workspaceScopeKey(path, identity, scope.clientNamespace), error);
  }
}
export function readComposerWorkspaceScope(
  path: string,
  identity: string | undefined,
  clientNamespace = "desktop",
): ComposerScope | undefined {
  try {
    const raw = getStorage()?.getItem(workspaceScopeKey(path, identity, clientNamespace));
    const value = raw ? JSON.parse(raw) : null;
    if (
      value?.clientNamespace === clientNamespace &&
      value.hostId === resolveComposerScope(null, identity, clientNamespace).hostId &&
      (value.projectId === null || typeof value.projectId === "string")
    )
      return value;
  } catch {
    /* 旧版没有导航身份，不能从目录猜项目。 */
  }
  return undefined;
}

function draftStorageKey(
  path: string,
  identity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): string {
  // 同目录可以属于多个项目；新建草稿按组织归属隔离，正式 session 仍按工作区隔离。
  return scopeId === V4_DRAFT_SCOPE_ROOT && scope
    ? `zcode-v4-composer-project-drafts:v1:${composerScopeKey(scope)}`
    : getV4ComposerDraftStorageKey(path, identity);
}
export const V4_DRAFT_SCOPE_ROOT = "__draft__";
export const V4_WORKTREE_RECOVERY_PENDING_SCOPE = "__worktree_recovery_pending__";

export function getV4WorktreeRecoveryScope(sessionId: string, submissionId?: string): string {
  return submissionId
    ? `__worktree_recovery_v2__:${encodeURIComponent(sessionId)}:${submissionId}`
    : `__worktree_recovery__:${sessionId}`;
}

export function readV4WorktreeRecoveryDrafts(
  path: string,
  identity: string | undefined,
  sessionId: string,
) {
  const prefix = `__worktree_recovery_v2__:${encodeURIComponent(sessionId)}:`;
  const legacy = getV4WorktreeRecoveryScope(sessionId);
  return Object.entries(readDraftFile(getV4ComposerDraftStorageKey(path, identity)).scopes)
    .filter(
      ([scope, draft]) =>
        scope === legacy ||
        scope.startsWith(prefix) ||
        (scope.startsWith("__worktree_recovery") &&
          draft.firstSubmission?.reservation?.sessionId === sessionId) ||
        (sessionId === V4_DRAFT_SCOPE_ROOT &&
          (scope === V4_WORKTREE_RECOVERY_PENDING_SCOPE ||
            scope.startsWith(`${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:`))),
    )
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .map(([scope, draft]) => ({ scope, draft }));
}

export function updateV4FirstSubmission(
  path: string,
  identity: string | undefined,
  submissionId: string,
  update: Partial<NonNullable<V4ComposerDraft["firstSubmission"]>>,
): void {
  const key = getV4ComposerDraftStorageKey(path, identity);
  const file = readDraftFile(key);
  let changed = false;
  for (const draft of Object.values(file.scopes)) {
    if (draft.firstSubmission?.submissionId !== submissionId) continue;
    draft.firstSubmission = { ...draft.firstSubmission, ...update };
    changed = true;
  }
  if (changed && !writeDraftFile(key, file)) throw new Error("composer.draft-storage-unavailable");
}

const warnedStorageKeys = new Set<string>();
const DRAFT_CHANGE_EVENT = "zcode:v4-composer-draft-change";
const activeFirstSubmissions = new Set<string>();
let firstSubmissionRevision = 0;

export function setV4FirstSubmissionActive(
  path: string,
  identity: string | undefined,
  id: string,
  active: boolean,
) {
  const key = `${identity?.trim() || path}\0${id}`;
  if (active) activeFirstSubmissions.add(key);
  else activeFirstSubmissions.delete(key);
  firstSubmissionRevision++;
  window.dispatchEvent(new Event(DRAFT_CHANGE_EVENT));
}

export function isV4FirstSubmissionActive(path: string, identity: string | undefined, id: string) {
  return activeFirstSubmissions.has(`${identity?.trim() || path}\0${id}`);
}

export function getV4FirstSubmissionVersion(path: string, identity?: string) {
  return `${getV4ComposerDraftVersion(path, identity) ?? ""}:${firstSubmissionRevision}`;
}

export function subscribeV4ComposerDrafts(listener: () => void) {
  window.addEventListener(DRAFT_CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(DRAFT_CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function getV4ComposerDraftVersion(path: string, identity?: string) {
  try {
    return getStorage()?.getItem(getV4ComposerDraftStorageKey(path, identity)) ?? null;
  } catch {
    return null;
  }
}

function warnStorageFailure(key: string, error: unknown) {
  if (warnedStorageKeys.has(key)) return;
  warnedStorageKeys.add(key);
  logger.warn("[v4-composer-draft] 草稿持久化访问失败", {
    error: error instanceof Error ? error.message : String(error),
    key,
  });
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getV4ComposerDraftStorageKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function readDraftFile(key: string): V4DraftFile {
  const storage = getStorage();
  try {
    const raw = storage?.getItem(key);
    if (!raw) return { version: 1, scopes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) {
      return { version: 1, scopes: {} };
    }
    const scopes = Object.fromEntries(
      Object.entries(parsed.scopes).flatMap(([scopeId, value]) => {
        const draft = readDraft(value, scopeId);
        return draft ? [[scopeId, draft]] : [];
      }),
    );
    const file: V4DraftFile = {
      version: 1,
      scopes,
      ...(parsed.legacyClaimed === true ? { legacyClaimed: true } : {}),
    };
    // 读取可发生在 React render；旧空记录只过滤，物理清理由明确写入负责。
    return file;
  } catch (error) {
    warnStorageFailure(key, error);
    return { version: 1, scopes: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An explicit model pick made in an existing session is the only non-text state that keeps a draft
 * record (ISSUE-035). A model inherited from the Session Snapshot, or any new-task draft, never qualifies.
 */
function keepsExplicitModelPick(
  scopeId: string,
  draft: { modelSelection?: unknown; modelSelectionPicked?: unknown },
): boolean {
  return (
    scopeId !== V4_DRAFT_SCOPE_ROOT &&
    draft.modelSelectionPicked === true &&
    modelSelectionSchema.safeParse(draft.modelSelection).success
  );
}

function readDraft(value: unknown, scopeId: string): V4ComposerDraft | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const recoveryContexts = readRecoveryContexts(value.recoveryContexts);
  const worktreeIntent = readWorktreeIntent(value.worktreeIntent);
  const recoveryAttachments = Array.isArray(value.recoveryAttachments)
    ? value.recoveryAttachments
        .map(readRecoveryAttachment)
        .filter((item): item is V4ComposerRecoveryAttachment => item !== null)
    : undefined;
  // 无正文的 worktree 恢复记录仍要保留附件/上下文，否则失败后的草稿会在读取时丢失。
  const hasRecovery = Boolean(recoveryAttachments?.length) || hasRecoveryContexts(recoveryContexts);
  const keepsModelPick = keepsExplicitModelPick(scopeId, {
    modelSelection: value.modelSelection,
    modelSelectionPicked: value.modelSelectionPicked,
  });
  if (!value.text.trim() && !hasRecovery && !keepsModelPick) return null;
  const mode = submissionModeSchema.safeParse(value.mode);
  const selection = modelSelectionSchema.safeParse(value.modelSelection);
  // 坏 options 不应连带丢掉可确定的模型身份；不读取旧 provider/model/thought 别名。
  const identity = isRecord(value.modelSelection)
    ? modelSelectionSchema.safeParse({
        providerId: value.modelSelection.providerId,
        modelId: value.modelSelection.modelId,
      })
    : null;
  const modelSelection = selection.success
    ? selection.data
    : identity?.success
      ? identity.data
      : undefined;
  const mention = value.mention;
  const pending = value.firstSubmission;
  const incognito = incognitoProfileSchema.safeParse(isRecord(pending) ? pending.incognito : null);
  const firstSubmission: V4ComposerDraft["firstSubmission"] =
    isRecord(pending) &&
    typeof pending.submissionId === "string" &&
    typeof pending.ownerKey === "string" &&
    ["preparing", "sending", "failed", "unknown"].includes(String(pending.status))
      ? {
          submissionId: pending.submissionId,
          ownerKey: pending.ownerKey,
          ...(typeof pending.generation === "number" && Number.isFinite(pending.generation)
            ? { generation: pending.generation }
            : {}),
          status: pending.status as NonNullable<V4ComposerDraft["firstSubmission"]>["status"],
          ...(typeof pending.commandId === "string" ? { commandId: pending.commandId } : {}),
          ...(isRecord(pending.reservation) &&
          typeof pending.reservation.sessionId === "string" &&
          typeof pending.reservation.commandId === "string"
            ? {
                reservation: {
                  sessionId: pending.reservation.sessionId,
                  commandId: pending.reservation.commandId,
                },
              }
            : {}),
          ...(incognito.success ? { incognito: incognito.data } : {}),
        }
      : undefined;
  const hasMention =
    isRecord(mention) &&
    ["id", "category", "label", "value", "markdown"].every(
      (key) => typeof mention[key] === "string",
    ) &&
    ["files", "skills", "commands", "subagents", "whiteboards", "sessions", "plugins"].includes(
      String(mention.category),
    );
  return {
    text: value.text,
    ...(firstSubmission ? { firstSubmission } : {}),
    ...(recoveryContexts ? { recoveryContexts } : {}),
    ...(worktreeIntent ? { worktreeIntent } : {}),
    ...(recoveryAttachments ? { recoveryAttachments } : {}),
    ...(value.initializeFromNewTask === true && !mode.success
      ? { initializeFromNewTask: true as const }
      : {}),
    ...(value.taskGroupId === null || typeof value.taskGroupId === "string"
      ? { taskGroupId: value.taskGroupId as string | null }
      : {}),
    ...(value.projectId === null || (typeof value.projectId === "string" && value.projectId.trim())
      ? { projectId: value.projectId as string | null }
      : {}),
    ...(typeof value.editorStateJson === "string"
      ? { editorStateJson: value.editorStateJson }
      : {}),
    ...(hasMention ? { mention: mention as unknown as ComposerMentionPrefill } : {}),
    ...(mode.success ? { mode: mode.data === "plan" ? ("build" as const) : mode.data } : {}),
    ...(typeof value.planEnabled === "boolean"
      ? { planEnabled: value.planEnabled }
      : mode.success
        ? { planEnabled: mode.data === "plan" }
        : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(keepsModelPick ? { modelSelectionPicked: true as const } : {}),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function readRecoveryContexts(value: unknown): V4ComposerRecoveryContexts | undefined {
  if (!isRecord(value)) return undefined;
  const ofObjects = (list: unknown): unknown[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const items = list.filter((item) => isRecord(item));
    return items.length > 0 ? items : undefined;
  };
  const conversationQuotes = ofObjects(value.conversationQuotes);
  const codeComments = ofObjects(value.codeComments);
  const webElements = ofObjects(value.webElements);
  const pptxElements = ofObjects(value.pptxElements);
  const pluginUiContexts = ofObjects(value.pluginUiContexts);
  const sharedContextRefs = Array.isArray(value.sharedContextRefs)
    ? value.sharedContextRefs.filter(
        (item): item is { kind: "shared_context_import"; context_id: string } =>
          isRecord(item) &&
          item.kind === "shared_context_import" &&
          typeof item.context_id === "string" &&
          item.context_id.length > 0,
      )
    : [];
  if (
    !conversationQuotes &&
    !codeComments &&
    !webElements &&
    !pptxElements &&
    !pluginUiContexts &&
    sharedContextRefs.length === 0
  ) {
    return undefined;
  }
  return {
    ...(conversationQuotes
      ? { conversationQuotes: conversationQuotes as ConversationSelectionReference[] }
      : {}),
    ...(codeComments ? { codeComments: codeComments as CodeCommentComposerAttachment[] } : {}),
    ...(webElements ? { webElements: webElements as WebElementContextComposerAttachment[] } : {}),
    ...(pptxElements ? { pptxElements: pptxElements as PptxElementReference[] } : {}),
    ...(pluginUiContexts ? { pluginUiContexts: pluginUiContexts as PluginUiModelContext[] } : {}),
    ...(sharedContextRefs.length > 0 ? { sharedContextRefs: sharedContextRefs.slice(0, 1) } : {}),
  };
}

function hasRecoveryContexts(contexts: V4ComposerRecoveryContexts | undefined): boolean {
  return Boolean(
    contexts &&
    (contexts.conversationQuotes?.length ||
      contexts.codeComments?.length ||
      contexts.webElements?.length ||
      contexts.pptxElements?.length ||
      contexts.pluginUiContexts?.length ||
      contexts.sharedContextRefs?.length),
  );
}

function writeDraftFile(key: string, file: V4DraftFile) {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    const serialized =
      Object.keys(file.scopes).length || file.legacyClaimed ? JSON.stringify(file) : null;
    if (storage.getItem(key) === serialized) return true;
    if (serialized === null) storage.removeItem(key);
    else storage.setItem(key, serialized);
    warnedStorageKeys.delete(key);
    // 同页签内 storage 事件不会触发，恢复面板需要本地广播才能看到新草稿。
    window.dispatchEvent(new Event(DRAFT_CHANGE_EVENT));
    return true;
  } catch (error) {
    // 配额/隐私模式失败只降级为不持久化，不影响输入。
    warnStorageFailure(key, error);
    return false;
  }
}

export function readV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): V4ComposerDraft | null {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const draft = file.scopes[scopeId];
  if (!draft || typeof draft.text !== "string") {
    // 旧记录只有显式项目归属才能认领；未归类历史不能靠最近目录猜测。
    if (!file.legacyClaimed && scopeId === V4_DRAFT_SCOPE_ROOT && scope?.projectId) {
      const legacy = readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity))
        .scopes[scopeId];
      if (legacy?.projectId === scope.projectId) return legacy;
    }
    return null;
  }
  return draft;
}

export function persistV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  draft: Omit<V4ComposerDraft, "updatedAt">,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const hadDraft = Boolean(file.scopes[scopeId]);
  // 正文/模型各自更新草稿时不能抹掉项目意图；显式新建传 null 才清除项目归属。
  const savedGroupId = file.scopes[scopeId]?.taskGroupId;
  const savedProjectId = file.scopes[scopeId]?.projectId;
  const next = {
    ...draft,
    ...(draft.taskGroupId === undefined && savedGroupId !== undefined
      ? { taskGroupId: savedGroupId }
      : {}),
    ...(draft.projectId === undefined && savedProjectId !== undefined
      ? { projectId: savedProjectId }
      : {}),
  };
  // promotion 以后任务归属由 Host 查询；浏览器 Session 草稿不保留组织态副本。
  if (scopeId !== V4_DRAFT_SCOPE_ROOT) {
    delete next.projectId;
    delete next.taskGroupId;
  }
  // 空白页配置只留在 Composer 内存；不存在记录时也不执行无意义写盘。
  // worktree 恢复附件/上下文即使没有正文也必须保留，否则失败返回后的素材会丢失。
  const hasRecoveryPayload =
    Boolean(next.recoveryAttachments?.length) ||
    hasRecoveryContexts(next.recoveryContexts) ||
    Boolean(next.firstSubmission);
  if (!next.text.trim() && !hasRecoveryPayload && !keepsExplicitModelPick(scopeId, next)) {
    delete file.scopes[scopeId];
  } else {
    file.scopes[scopeId] = { ...next, updatedAt: Date.now() };
  }
  // 新 key 首次写入即结束旧目录认领；保留旧数据，避免删除失败或换目录后复活正文。
  if (
    scopeId === V4_DRAFT_SCOPE_ROOT &&
    scope?.projectId &&
    (hadDraft ||
      Boolean(file.scopes[scopeId]) ||
      readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity)).scopes[scopeId]
        ?.projectId === scope.projectId)
  )
    file.legacyClaimed = true;
  return writeDraftFile(key, file);
}

/** 旧版关闭分组草稿只撤销 placement；不能连带清空正在编辑的正文和项目。 */
export function clearV4ComposerDraftTaskGroup(
  workspacePath: string,
  workspaceIdentity?: string,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  const file = readDraftFile(key);
  const draft = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  if (!draft || draft.taskGroupId === undefined) return true;
  // 分组只是草稿的组织意图；关闭时必须沿用项目 key，不能修改同目录的其他项目。
  delete draft.taskGroupId;
  file.scopes[V4_DRAFT_SCOPE_ROOT] = draft;
  if (scope?.projectId) file.legacyClaimed = true;
  return writeDraftFile(key, file);
}

export function clearV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const hadDraft = Boolean(file.scopes[scopeId]);
  delete file.scopes[scopeId];
  // 新 key 首次写入即结束旧目录认领；保留旧数据，避免删除失败或换目录后复活正文。
  if (
    scopeId === V4_DRAFT_SCOPE_ROOT &&
    scope?.projectId &&
    (hadDraft ||
      Boolean(file.scopes[scopeId]) ||
      readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity)).scopes[scopeId]
        ?.projectId === scope.projectId)
  )
    file.legacyClaimed = true;
  return writeDraftFile(key, file);
}

/** Transfer one recovery record without temporarily duplicating its storage footprint. */
export function moveV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  source: string,
  target: string,
): boolean {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readDraftFile(key);
  const draft = file.scopes[source];
  if (!draft) return false;
  if (source === target) return true;
  file.scopes[target] = draft;
  delete file.scopes[source];
  return writeDraftFile(key, file);
}
