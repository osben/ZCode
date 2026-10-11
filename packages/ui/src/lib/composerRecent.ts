import { isHighspeedProviderId } from "@zcode/shared";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { logger } from "@/logger.js";

// Keep the old key and support historical records that stored only ModelSelection when reading.
const COMPOSER_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ComposerRecent {
  readonly modelSelection?: ModelSelection;
  readonly mode?: SubmissionMode;
}

let submissionSequence = 0;
const acceptedSequences = new WeakMap<StorageLike, Map<string, number>>();

function resolveComposerRecentKey(workspacePath: string, workspaceIdentity?: string): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${COMPOSER_RECENT_KEY_PREFIX}:${workspaceKey}`;
}

export function readComposerRecent(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): ComposerRecent | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(resolveComposerRecentKey(workspacePath, workspaceIdentity));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    // Validate the two leaves independently; an expired model or bad data must not discard a valid permission, and vice versa.
    const selection = modelSelectionSchema.safeParse(
      "modelSelection" in record ? record.modelSelection : record,
    );
    const mode = submissionModeSchema.safeParse("mode" in record ? record.mode : undefined);
    // Self-healing (spec §5.1): an existing Recent entry may have been overwritten by an accelerated
    // turn with a hidden acceleration Provider. The model view resolves it as provider-not-found,
    // leaving the new-task model picker empty. Drop the model at the leaf but keep mode so the new
    // draft falls back to the default selection, matching readSessionModelSelection's handling of
    // persistent acceleration entries.
    const healedSelection =
      selection.success && !isHighspeedProviderId(selection.data.providerId)
        ? selection.data
        : undefined;
    if (!healedSelection && !mode.success) return null;
    return {
      ...(healedSelection ? { modelSelection: healedSelection } : {}),
      ...(mode.success ? { mode: mode.data } : {}),
    };
  } catch {
    return null;
  }
}

/** Capture when a real Submission starts; call the returned function only after an accepted ACK. */
export function captureComposerRecentSubmission(
  workspacePath: string,
  submission: { readonly modelSelection: ModelSelection; readonly mode: SubmissionMode },
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): () => void {
  if (!storage) return () => {};
  const key = resolveComposerRecentKey(workspacePath, workspaceIdentity);
  const mode = submissionModeSchema.safeParse(submission.mode);
  const modelSelection = normalizeSparseModelSelection(submission.modelSelection);
  if (modelSelection && isHighspeedProviderId(modelSelection.providerId)) {
    // Fallback (spec §5.1): the acceleration Provider is a one-turn execution identity and appears
    // in no model catalog, so storing it in Recent would make the new-task draft seed resolve to
    // empty. Normally SessionPane passes the Composer's original selection for an accelerated turn;
    // this guards only paths that call with the overridden payload directly. Skip without advancing
    // the index, preserving the last valid entry.
    logger.warn("[ComposerRecent] 提交指向加速卡 Provider，跳过偏好记录", {
      workspacePath,
      workspaceIdentity,
    });
    return () => {};
  }
  if (!mode.success || !modelSelection) {
    // Recent is a preference saved after sending; on invalid input, skip recording but do not block the authoritative command.
    logger.warn("[ComposerRecent] 最近提交配置格式无效，跳过偏好记录", {
      workspacePath,
      workspaceIdentity,
    });
    return () => {};
  }
  const sequence = ++submissionSequence;
  const recent = {
    modelSelection,
    mode: mode.data,
  };
  let accepted = acceptedSequences.get(storage);
  if (!accepted) {
    accepted = new Map();
    acceptedSequences.set(storage, accepted);
  }
  return () => {
    // Saving only the model would lose the permission after the initial migration to Root; save both fields together.
    // Within one Renderer, use the latest accepted submission by start order so a late ACK from another Pane cannot overwrite newer preferences.
    // Unaccepted candidates do not advance the watermark or change the draft/CLI input queue.
    if (sequence <= (accepted.get(key) ?? 0)) return;
    accepted.set(key, sequence);
    try {
      storage.setItem(key, JSON.stringify(recent));
    } catch (error) {
      // The authoritative send was accepted; failure to write local preferences must not report the send as failed.
      logger.warn("[ComposerRecent] 保存最近提交配置失败", {
        workspacePath,
        workspaceIdentity,
        error,
      });
    }
  };
}

export function resolveDraftInitialModelSelection(
  view: ModelSelectionView | null,
  recent: ModelSelection | null,
): { readonly selection: ModelSelection | null; readonly invalidated: boolean } {
  // Do not treat existing draft intent as invalid before the Registry arrives; preserve it unchanged until the same Hook
  // receives the View and can validate its meaning.
  if (!view) return { selection: recent, invalidated: false };
  if (recent) {
    const model = findModel(view, recent);
    if (!model) return { selection: null, invalidated: true };
    const reasoning = recent.options?.reasoningLevel;
    if (
      reasoning === undefined ||
      !model.config.optionSpecs.reasoningLevel.values.includes(reasoning)
    ) {
      // Keep Provider/Model identity but clear the invalid level; Composer shows no generic notice,
      // and the empty Reasoning control asks the user to make a new explicit choice.
      return {
        selection: { providerId: recent.providerId, modelId: recent.modelId },
        invalidated: true,
      };
    }
    return { selection: recent, invalidated: false };
  }
  return {
    selection:
      view.preferredSelection && isSelectionInView(view, view.preferredSelection)
        ? view.preferredSelection
        : null,
    invalidated: recent !== null,
  };
}

export function isSelectionInView(view: ModelSelectionView, selection: ModelSelection): boolean {
  const model = findModel(view, selection);
  if (!model) return false;
  const reasoning = selection.options?.reasoningLevel;
  const reasoningSpec = model.config.optionSpecs.reasoningLevel;
  return reasoning !== undefined && reasoningSpec.values.includes(reasoning);
}

function findModel(view: ModelSelectionView, selection: ModelSelection) {
  return view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
}

function normalizeSparseModelSelection(selection: ModelSelection): ModelSelection | null {
  const candidate =
    selection && typeof selection === "object" && !Array.isArray(selection) ? selection : null;
  const options = candidate?.options;
  const normalizedOptions =
    options?.reasoningLevel !== undefined ? { reasoningLevel: options.reasoningLevel } : {};
  const parsed = modelSelectionSchema.safeParse({
    providerId: candidate?.providerId,
    modelId: candidate?.modelId,
    ...(Object.keys(normalizedOptions).length > 0 ? { options: normalizedOptions } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
