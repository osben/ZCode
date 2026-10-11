// Composer parity: per-session draft persistence for the v4 composer (new, lightweight localStorage implementation).
//
// The old draft surface (zcodeSessionStore composerDraftByScopeId + chatComposerDraftStorage write path)
// was removed during store cleanup; this module replaces it for v4, with a separate key space (v4 prefix) that does not write to old keys.
// Cleanup of old keys remains the responsibility of chatComposerDraftStorage's janitor.
// Semantics: scope = sessionId (draft state = "__draft__"); persist text + editorStateJson, and save external mentions separately while
// Lexical is not mounted yet (so remounting does not degrade them to plain text).
// Save mode/modelSelection under the same scope as the body; sending clears only content, while explicit cleanup deletes the whole scope.
// Attachments are not persisted in drafts (objectUrl/File cannot be serialized, and ownership of localPath attachments is hard to validate after restart —
// consistent with the decision that the v4 composer does not persist attachment drafts).
import { logger } from "@/logger.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

export interface V4ComposerDraft {
  text: string;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  /** A valid mode means this is initialized; no model is still an explicit empty state and must not be filled from an old text draft. */
  mode?: SubmissionMode;
  planEnabled?: boolean;
  /** Tool changes already applied, preventing a reconnect snapshot from overwriting the user's choice again. */
  lastPlanTransitionId?: string;
  lastPermissionGrantId?: string;
  modelSelection?: ModelSelection;
  /** First share import waits for shared new-task initialization; an empty Session snapshot must not populate it first. */
  initializeFromNewTask?: true;
  updatedAt: number;
}

interface V4DraftFile {
  version: 1;
  scopes: Record<string, V4ComposerDraft>;
}

const STORAGE_KEY_PREFIX = "zcode-v4-composer-drafts:v1:";
export const V4_DRAFT_SCOPE_ROOT = "__draft__";
const warnedStorageKeys = new Set<string>();

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
        const draft = readDraft(value);
        return draft ? [[scopeId, draft]] : [];
      }),
    );
    return { version: 1, scopes };
  } catch (error) {
    warnStorageFailure(key, error);
    return { version: 1, scopes: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDraft(value: unknown): V4ComposerDraft | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const mode = submissionModeSchema.safeParse(value.mode);
  const selection = modelSelectionSchema.safeParse(value.modelSelection);
  // Invalid options should not discard a model identity that can still be determined; do not read legacy provider/model/thought aliases.
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
    ...(typeof value.lastPermissionGrantId === "string"
      ? { lastPermissionGrantId: value.lastPermissionGrantId }
      : {}),
    ...(typeof value.lastPlanTransitionId === "string"
      ? { lastPlanTransitionId: value.lastPlanTransitionId }
      : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(value.initializeFromNewTask === true && !mode.success
      ? { initializeFromNewTask: true as const }
      : {}),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function writeDraftFile(key: string, file: V4DraftFile) {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    if (Object.keys(file.scopes).length === 0) {
      storage.removeItem(key);
      return true;
    }
    storage.setItem(key, JSON.stringify(file));
    warnedStorageKeys.delete(key);
    return true;
  } catch (error) {
    // Quota/private-mode failures only disable persistence; they do not affect input.
    warnStorageFailure(key, error);
    return false;
  }
}

export function readV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): V4ComposerDraft | null {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const draft = readDraftFile(key).scopes[scopeId];
  if (!draft || typeof draft.text !== "string") {
    return null;
  }
  return draft;
}

export function persistV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  draft: Omit<V4ComposerDraft, "updatedAt">,
) {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readDraftFile(key);
  if (
    !draft.text.trim() &&
    !draft.editorStateJson &&
    !draft.mention &&
    !draft.mode &&
    !draft.modelSelection &&
    !draft.initializeFromNewTask
  ) {
    delete file.scopes[scopeId];
  } else {
    file.scopes[scopeId] = { ...draft, updatedAt: Date.now() };
  }
  return writeDraftFile(key, file);
}

export function clearV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
) {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readDraftFile(key);
  if (!(scopeId in file.scopes)) {
    return true;
  }
  delete file.scopes[scopeId];
  return writeDraftFile(key, file);
}
