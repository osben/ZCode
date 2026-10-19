import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { normalizeSystemPromptText, type SystemPromptOverrideKey } from "@zcode/shared";
import type { ISystemPromptService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  type EditableSystemPromptSection,
  isSystemPromptDraftDirty,
  orderedEditableSystemPromptSections,
  resolveSystemPromptSaveBlockReason,
  makeEditorState,
  revisionOf,
  sameSections,
  settleConflictAgainstListing,
  tallyOverrideResets,
  type DeleteOutcome,
  type SystemPromptEditorState,
} from "@/settings/systemPromptEditorModel.js";
import {
  getUserInstructionsHostKey,
  isRemoteUserInstructionsTarget,
  isUnknownChannelError,
  type UserInstructionsHostTarget,
} from "@/settings/userInstructionsEditorModel.js";

export type { SystemPromptEditorState } from "@/settings/systemPromptEditorModel.js";

export type SystemPromptOverridesStatus =
  | "waiting"
  | "loading"
  | "ready"
  | "unsupported"
  | "failed";

export interface SystemPromptSaveConflict {
  /** Disk revision found by the conflicting save; the card reviews it before the next Overwrite. */
  currentRevision: string | null;
}

export interface ResetEntry {
  key: SystemPromptOverrideKey;
  /** Revision the user saw when confirming; `undefined` skips the check (older hosts). */
  expectedRevision?: string | null;
}

export interface SystemPromptOverridesView {
  hostKey: string;
  isRemote: boolean;
  status: SystemPromptOverridesStatus;
  sections: readonly EditableSystemPromptSection[];
  editor: SystemPromptEditorState | null;
  editorDirty: boolean;
  /** The open editor's section changed on disk since its revision was captured. */
  editorDiskChanged: boolean;
  canSaveEditor: boolean;
  reload: () => void;
  openEditor: (key: SystemPromptOverrideKey, effectiveContent: string) => void;
  closeEditor: () => void;
  setDraft: (draft: string) => void;
  /**
   * Save the draft. `overwrite` replaces a disk change: it is checked against `reviewedRevision`, the
   * disk revision the user saw in the conflict card, so a newer external edit is never replaced unseen.
   * A conflicting save resolves to the disk revision it found; any other outcome resolves to undefined.
   */
  saveEditor: (options?: {
    overwrite?: { reviewedRevision: string | null | undefined };
  }) => Promise<SystemPromptSaveConflict | undefined>;
  /** Discard the draft and rebase the editor onto the current disk text and revision. */
  reloadEditor: (effectiveContent: string) => void;
  /** Override directory on the pinned host (the service's pure lookup). */
  getOverridesDirectory: () => Promise<string>;
  restoreDefault: (key: SystemPromptOverrideKey, expectedRevision?: string | null) => Promise<void>;
  resetAllCustomized: (entries: readonly ResetEntry[]) => Promise<void>;
}

/** Focus refreshes are at most this often; a list already in flight also suppresses one. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 2_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSystemPromptOverrides(
  target: UserInstructionsHostTarget,
): SystemPromptOverridesView {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId ?? null,
    target.workspaceIdentity ?? null,
    target.remoteTarget,
  );
  const isRemote = isRemoteUserInstructionsTarget(target);
  const hostKey = getUserInstructionsHostKey(target);
  const rpcReady = isRemote ? resolution.isRemoteTarget && resolution.rpcReady : true;
  const service = isRemote
    ? resolution.services.systemPromptService
    : baseServices.systemPromptService;
  const serviceRef = useRef<ISystemPromptService>(service);
  useLayoutEffect(() => {
    serviceRef.current = service;
  }, [service]);

  const [status, setStatus] = useState<SystemPromptOverridesStatus>("loading");
  const [sections, setSections] = useState<readonly EditableSystemPromptSection[]>([]);
  const [editor, setEditor] = useState<SystemPromptEditorState | null>(null);
  // Restore and reset read the editor from here, not from a dependency: their identity must not change
  // on every keystroke, because the memoized rows receive them.
  const editorRef = useRef<SystemPromptEditorState | null>(null);
  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  // Bumped on every host reset; async work captured under an older epoch must not touch state.
  const epochRef = useRef(0);
  // Bumped per listing; only the newest listing for an epoch may apply, so an older response cannot
  // overwrite a fresher one.
  const listVersionRef = useRef(0);
  const loadedHostKeyRef = useRef<string | null>(null);
  const listsInFlightRef = useRef(0);
  const lastFocusRefreshAtRef = useRef(0);

  const resetForHost = useCallback(() => {
    epochRef.current += 1;
    listVersionRef.current += 1;
    loadedHostKeyRef.current = null;
    setSections([]);
    setEditor(null);
    setStatus("loading");
  }, []);

  /** Fetch and apply the listing in place. Throws on service errors; callers decide what to show. */
  const listInPlace = useCallback(
    async (targetService: ISystemPromptService, key: string): Promise<void> => {
      const epoch = epochRef.current;
      const version = listVersionRef.current + 1;
      listVersionRef.current = version;
      listsInFlightRef.current += 1;
      try {
        const result = await targetService.listSections();
        if (epoch !== epochRef.current || version !== listVersionRef.current) return;
        loadedHostKeyRef.current = key;
        const next = orderedEditableSystemPromptSections(result.sections);
        // An unchanged listing keeps the previous array, so consumers do not re-render for nothing.
        setSections((previous) => (sameSections(previous, next) ? previous : next));
        // A failed listing never reaches here, so the conflict state survives it.
        setEditor((current) => (current ? settleConflictAgainstListing(current, next) : current));
        setStatus("ready");
      } finally {
        listsInFlightRef.current -= 1;
      }
    },
    [],
  );

  /** First load for a host: the only path that shows the loading state. */
  const loadFirst = useCallback(
    async (key: string, targetService: ISystemPromptService) => {
      const epoch = epochRef.current;
      try {
        await listInPlace(targetService, key);
      } catch (error) {
        if (epoch !== epochRef.current) return;
        const unsupported = isUnknownChannelError(error);
        setSections([]);
        setStatus(unsupported ? "unsupported" : "failed");
        logger.warn("[SystemPrompt] Failed to load prompt overrides", {
          unsupported,
          error: errorMessage(error),
        });
      }
    },
    [listInPlace],
  );

  /** Refresh after a save, restore or focus. Keeps the list, scroll position and editor mounted. */
  const refreshInPlace = useCallback(
    async (targetService: ISystemPromptService, key: string) => {
      const epoch = epochRef.current;
      try {
        await listInPlace(targetService, key);
      } catch (error) {
        if (epoch !== epochRef.current) return;
        logger.warn("[SystemPrompt] Failed to refresh prompt overrides", {
          error: errorMessage(error),
        });
      }
    },
    [listInPlace],
  );

  useEffect(() => {
    if (loadedHostKeyRef.current === hostKey) return;
    resetForHost();
    if (!rpcReady) {
      setStatus("waiting");
      return;
    }
    void loadFirst(hostKey, serviceRef.current);
  }, [hostKey, loadFirst, resetForHost, rpcReady]);

  // Refresh on window focus so an external edit shows up without a manual reload. Silent: no
  // loading card, and the open editor (if any) shows the disk-changed state when it differs.
  useEffect(() => {
    if (!rpcReady) return undefined;
    const handleFocus = () => {
      if (loadedHostKeyRef.current !== hostKey) return;
      if (listsInFlightRef.current > 0) return;
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
      lastFocusRefreshAtRef.current = now;
      void refreshInPlace(serviceRef.current, hostKey);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [hostKey, refreshInPlace, rpcReady]);

  const reload = useCallback(() => {
    if (!rpcReady) return;
    if (status === "failed") {
      resetForHost();
      void loadFirst(hostKey, serviceRef.current);
      return;
    }
    void refreshInPlace(serviceRef.current, hostKey);
  }, [hostKey, loadFirst, refreshInPlace, resetForHost, rpcReady, status]);

  const openEditor = useCallback(
    (key: SystemPromptOverrideKey, effectiveContent: string) => {
      setEditor(makeEditorState(key, effectiveContent, revisionOf(sections, key)));
    },
    [sections],
  );

  const closeEditor = useCallback(() => setEditor(null), []);

  const setDraft = useCallback((draft: string) => {
    setEditor((current) => (current ? { ...current, draft } : current));
  }, []);

  // Reload discards the draft, so adopting the disk text current at click time cannot replace
  // anything the user has typed or seen.
  const reloadEditor = useCallback(
    (effectiveContent: string) => {
      setEditor((current) =>
        current
          ? makeEditorState(current.key, effectiveContent, revisionOf(sections, current.key))
          : current,
      );
    },
    [sections],
  );

  /**
   * Delete each entry under its own file lock, concurrently (one file per key). The outcome list
   * matches `entries` by index. A rejected call is logged and reported as `failed`.
   */
  const deleteEntries = useCallback(
    async (
      targetService: ISystemPromptService,
      entries: readonly ResetEntry[],
    ): Promise<DeleteOutcome[]> => {
      const settled = await Promise.allSettled(
        entries.map((entry) =>
          targetService.deleteOverride({
            key: entry.key,
            expectedRevision: entry.expectedRevision,
          }),
        ),
      );
      return settled.map((outcome, index): DeleteOutcome => {
        if (outcome.status === "rejected") {
          logger.warn("[SystemPrompt] Failed to remove prompt override", {
            key: entries[index]!.key,
            error: errorMessage(outcome.reason),
          });
          return "failed";
        }
        const result = outcome.value;
        return result && result.kind === "conflict" ? "conflict" : "ok";
      });
    },
    [],
  );

  const saveEditor = useCallback(
    async (options?: { overwrite?: { reviewedRevision: string | null | undefined } }) => {
      const current = editor;
      if (current === null || !rpcReady) return;
      if (resolveSystemPromptSaveBlockReason(current) !== null) return;
      const key = hostKey;
      const epoch = epochRef.current;
      const targetService = serviceRef.current;
      // While a conflict is active only Overwrite writes. A plain save would replace a disk version
      // the user has not reviewed.
      if (!options?.overwrite && current.conflictRevision !== undefined) return;
      // Overwrite targets the disk revision the user reviewed (the card passes it). It is never read
      // from the listing at click time, which may be newer than what the user was shown.
      const expectedRevision = options?.overwrite
        ? options.overwrite.reviewedRevision
        : current.baseRevision;
      const content = normalizeSystemPromptText(current.draft);
      setEditor((latest) => (latest ? { ...latest, saving: true } : latest));
      try {
        const result = await targetService.writeOverride({
          key: current.key,
          content,
          expectedRevision,
        });
        if (epoch !== epochRef.current) return;
        if (result && result.kind === "conflict") {
          // The file changed after the draft's revision. Nothing was written. The conflict revision is
          // kept on the editor, so the disk-changed choices show even if the refresh below fails.
          if (options?.overwrite) {
            // The card already shows; a second change since review needs an explicit signal.
            toast(intl.formatMessage({ id: "settings.systemPrompt.changedOnDisk" }));
          }
          setEditor((latest) =>
            latest?.key === current.key
              ? { ...latest, saving: false, conflictRevision: result.currentRevision }
              : latest,
          );
          void refreshInPlace(targetService, key);
          return { currentRevision: result.currentRevision };
        }
        toast(intl.formatMessage({ id: "settings.systemPrompt.saved" }));
        setEditor(null);
        if (result && result.kind === "ok") {
          // The write result carries the stored text and its revision, so the saved row updates
          // without a second listing.
          const savedRevision = result.revision;
          // A listing already in flight read the file before this write; invalidate it so its stale
          // rows cannot replace the row patched here.
          listVersionRef.current += 1;
          setSections((previous) =>
            previous.map((section) =>
              section.key === current.key
                ? {
                    ...section,
                    overrideContent: content,
                    isOverridden: true,
                    revision: savedRevision,
                  }
                : section,
            ),
          );
        } else {
          // Hosts that do not report the written revision are relisted.
          void refreshInPlace(targetService, key);
        }
      } catch (error) {
        if (epoch !== epochRef.current) return;
        logger.warn("[SystemPrompt] Failed to save prompt override", {
          key: current.key,
          error: errorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
        setEditor((latest) => (latest ? { ...latest, saving: false } : latest));
      }
    },
    [editor, hostKey, intl, refreshInPlace, rpcReady],
  );

  const restoreDefault = useCallback(
    async (key: SystemPromptOverrideKey, expectedRevision?: string | null) => {
      if (!rpcReady) return;
      const host = hostKey;
      const epoch = epochRef.current;
      const targetService = serviceRef.current;
      const startEditor = editorRef.current;
      const [outcome] = await deleteEntries(targetService, [{ key, expectedRevision }]);
      if (epoch !== epochRef.current) return;
      if (outcome === "failed") {
        toast(intl.formatMessage({ id: "settings.systemPrompt.restoreFailed" }));
        return;
      }
      if (outcome === "conflict") {
        toast(intl.formatMessage({ id: "settings.systemPrompt.changedOnDisk" }));
        void refreshInPlace(targetService, host);
        return;
      }
      toast(intl.formatMessage({ id: "settings.systemPrompt.restored" }));
      // Close only the editor open when Restore started; a reopened or edited one is a new object.
      if (startEditor?.key === key) setEditor((latest) => (latest === startEditor ? null : latest));
      void refreshInPlace(targetService, host);
    },
    [deleteEntries, hostKey, intl, refreshInPlace, rpcReady],
  );

  const resetAllCustomized = useCallback(
    async (entries: readonly ResetEntry[]) => {
      if (!rpcReady || entries.length === 0) return;
      const host = hostKey;
      const epoch = epochRef.current;
      const targetService = serviceRef.current;
      const startEditor = editorRef.current;
      const outcomes = await deleteEntries(targetService, entries);
      if (epoch !== epochRef.current) return;
      const { restoredKeys, conflicts, failed } = tallyOverrideResets(entries, outcomes);
      // Same rule as restoreDefault: only the editor that was open when the reset started may close.
      if (startEditor && restoredKeys.has(startEditor.key)) {
        setEditor((latest) => (latest === startEditor ? null : latest));
      }
      void refreshInPlace(targetService, host);
      if (conflicts === 0 && failed === 0) {
        toast(
          intl.formatMessage(
            { id: "settings.systemPrompt.resetAllDone" },
            { count: restoredKeys.size },
          ),
        );
      } else {
        toast(
          intl.formatMessage(
            { id: "settings.systemPrompt.resetAllPartial" },
            { restored: restoredKeys.size, conflicts, failed },
          ),
        );
      }
    },
    [deleteEntries, hostKey, intl, refreshInPlace, rpcReady],
  );

  const getOverridesDirectory = useCallback(async () => {
    const result = await serviceRef.current.getOverridesDirectory();
    return result.path;
  }, []);

  const effectiveStatus: SystemPromptOverridesStatus = rpcReady ? status : "waiting";
  // Dirty and the save block reason are computed once per render and reused below.
  const editorDirty = editor !== null && isSystemPromptDraftDirty(editor.baseline, editor.draft);
  const editorSaveBlock = editor === null ? null : resolveSystemPromptSaveBlockReason(editor);
  const editorSection =
    editor === null ? undefined : sections.find((candidate) => candidate.key === editor.key);
  const editorDiskChanged =
    editor !== null &&
    (editor.conflictRevision !== undefined ||
      (editorSection !== undefined &&
        editorSection.revision !== undefined &&
        editorSection.revision !== editor.baseRevision));
  const canSaveEditor =
    editor !== null &&
    effectiveStatus === "ready" &&
    !editorDiskChanged &&
    editorSaveBlock === null;

  return {
    hostKey,
    isRemote,
    status: effectiveStatus,
    sections,
    editor,
    editorDirty,
    editorDiskChanged,
    canSaveEditor,
    reload,
    openEditor,
    closeEditor,
    setDraft,
    saveEditor,
    reloadEditor,
    getOverridesDirectory,
    restoreDefault,
    resetAllCustomized,
  };
}
