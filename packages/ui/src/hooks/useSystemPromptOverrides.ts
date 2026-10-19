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
  canSaveSystemPromptDraft,
  type EditableSystemPromptSection,
  isSystemPromptDraftDirty,
  orderedEditableSystemPromptSections,
} from "@/settings/systemPromptEditorModel.js";
import {
  getUserInstructionsHostKey,
  isRemoteUserInstructionsTarget,
  isUnknownChannelError,
  type UserInstructionsHostTarget,
} from "@/settings/userInstructionsEditorModel.js";

export type SystemPromptOverridesStatus =
  | "waiting"
  | "loading"
  | "ready"
  | "unsupported"
  | "failed";

export interface SystemPromptEditorState {
  key: SystemPromptOverrideKey;
  /** Effective text when the editor opened (or was last rebased onto disk). "Changes vs saved" compares to it. */
  baseline: string;
  draft: string;
  saving: boolean;
  /**
   * Section revision the draft was based on. `undefined` on hosts without revisions, which turns
   * conflict checking off for this editor.
   */
  baseRevision: string | null | undefined;
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
  /** Save the draft. `overwrite` replaces a disk change by using the current disk revision. */
  saveEditor: (options?: { overwrite?: boolean }) => Promise<void>;
  /** Discard the draft and rebase the editor onto the current disk text and revision. */
  reloadEditor: (effectiveContent: string) => void;
  /** Override directory on the pinned host (the service's pure lookup). */
  getOverridesDirectory: () => Promise<string>;
  restoreDefault: (key: SystemPromptOverrideKey, expectedRevision?: string | null) => Promise<void>;
  resetAllCustomized: (entries: readonly ResetEntry[]) => Promise<void>;
}

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
  // Bumped on every host reset; async work captured under an older epoch must not touch state.
  const epochRef = useRef(0);
  // Bumped per listing; only the newest listing for an epoch may apply, so an older response cannot
  // overwrite a fresher one.
  const listVersionRef = useRef(0);
  const loadedHostKeyRef = useRef<string | null>(null);

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
      const result = await targetService.listSections();
      if (epoch !== epochRef.current || version !== listVersionRef.current) return;
      loadedHostKeyRef.current = key;
      setSections(orderedEditableSystemPromptSections(result.sections));
      setStatus("ready");
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
      const section = sections.find((candidate) => candidate.key === key);
      setEditor({
        key,
        baseline: effectiveContent,
        draft: effectiveContent,
        saving: false,
        baseRevision: section?.revision,
      });
    },
    [sections],
  );

  const closeEditor = useCallback(() => setEditor(null), []);

  const setDraft = useCallback((draft: string) => {
    setEditor((current) => (current ? { ...current, draft } : current));
  }, []);

  const reloadEditor = useCallback(
    (effectiveContent: string) => {
      setEditor((current) => {
        if (!current) return current;
        const section = sections.find((candidate) => candidate.key === current.key);
        return {
          key: current.key,
          baseline: effectiveContent,
          draft: effectiveContent,
          saving: false,
          baseRevision: section?.revision,
        };
      });
    },
    [sections],
  );

  const saveEditor = useCallback(
    async (options?: { overwrite?: boolean }) => {
      const current = editor;
      if (current === null || !rpcReady) return;
      if (
        !canSaveSystemPromptDraft({
          baseline: current.baseline,
          draft: current.draft,
          saving: current.saving,
        })
      ) {
        return;
      }
      const key = hostKey;
      const epoch = epochRef.current;
      const targetService = serviceRef.current;
      const section = sections.find((candidate) => candidate.key === current.key);
      const expectedRevision = options?.overwrite ? section?.revision : current.baseRevision;
      const content = normalizeSystemPromptText(current.draft);
      const params =
        expectedRevision === undefined
          ? { key: current.key, content }
          : { key: current.key, content, expectedRevision };
      setEditor({ ...current, saving: true });
      try {
        const result = await targetService.writeOverride(params);
        if (epoch !== epochRef.current) return;
        if (result && result.kind === "conflict") {
          // The file changed after the draft's revision. Nothing was written; the refreshed list
          // makes the editor show the disk-changed choices.
          setEditor((latest) => (latest ? { ...latest, saving: false } : latest));
          void refreshInPlace(targetService, key);
          return;
        }
        toast(intl.formatMessage({ id: "settings.systemPrompt.saved" }));
        setEditor(null);
        void refreshInPlace(targetService, key);
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
    [editor, hostKey, intl, refreshInPlace, rpcReady, sections],
  );

  const restoreDefault = useCallback(
    async (key: SystemPromptOverrideKey, expectedRevision?: string | null) => {
      if (!rpcReady) return;
      const host = hostKey;
      const epoch = epochRef.current;
      const targetService = serviceRef.current;
      const params = expectedRevision === undefined ? { key } : { key, expectedRevision };
      try {
        const result = await targetService.deleteOverride(params);
        if (epoch !== epochRef.current) return;
        if (result && result.kind === "conflict") {
          toast(intl.formatMessage({ id: "settings.systemPrompt.changedOnDisk" }));
          void refreshInPlace(targetService, host);
          return;
        }
        toast(intl.formatMessage({ id: "settings.systemPrompt.restored" }));
        if (editor?.key === key) setEditor(null);
        void refreshInPlace(targetService, host);
      } catch (error) {
        if (epoch !== epochRef.current) return;
        logger.warn("[SystemPrompt] Failed to restore prompt default", {
          key,
          error: errorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.systemPrompt.restoreFailed" }));
      }
    },
    [editor?.key, hostKey, intl, refreshInPlace, rpcReady],
  );

  const resetAllCustomized = useCallback(
    async (entries: readonly ResetEntry[]) => {
      if (!rpcReady || entries.length === 0) return;
      const host = hostKey;
      const epoch = epochRef.current;
      const targetService = serviceRef.current;
      let restored = 0;
      let conflicts = 0;
      let failed = 0;
      const restoredKeys = new Set<SystemPromptOverrideKey>();
      for (const entry of entries) {
        const params =
          entry.expectedRevision === undefined
            ? { key: entry.key }
            : { key: entry.key, expectedRevision: entry.expectedRevision };
        try {
          const result = await targetService.deleteOverride(params);
          if (result && result.kind === "conflict") {
            conflicts += 1;
          } else {
            restored += 1;
            restoredKeys.add(entry.key);
          }
        } catch (error) {
          failed += 1;
          logger.warn("[SystemPrompt] Failed to reset prompt override", {
            key: entry.key,
            error: errorMessage(error),
          });
        }
      }
      if (epoch !== epochRef.current) return;
      if (editor && restoredKeys.has(editor.key)) setEditor(null);
      void refreshInPlace(targetService, host);
      if (conflicts === 0 && failed === 0) {
        toast(
          intl.formatMessage({ id: "settings.systemPrompt.resetAllDone" }, { count: restored }),
        );
      } else {
        toast(
          intl.formatMessage(
            { id: "settings.systemPrompt.resetAllPartial" },
            { restored, conflicts, failed },
          ),
        );
      }
    },
    [editor, hostKey, intl, refreshInPlace, rpcReady],
  );

  const getOverridesDirectory = useCallback(async () => {
    const result = await serviceRef.current.getOverridesDirectory();
    return result.path;
  }, []);

  const effectiveStatus: SystemPromptOverridesStatus = rpcReady ? status : "waiting";
  const editorDirty = editor !== null && isSystemPromptDraftDirty(editor.baseline, editor.draft);
  const editorSection =
    editor === null ? undefined : sections.find((candidate) => candidate.key === editor.key);
  const editorDiskChanged =
    editor !== null &&
    editorSection !== undefined &&
    editorSection.revision !== undefined &&
    editorSection.revision !== editor.baseRevision;
  const canSaveEditor =
    editor !== null &&
    effectiveStatus === "ready" &&
    !editorDiskChanged &&
    canSaveSystemPromptDraft({
      baseline: editor.baseline,
      draft: editor.draft,
      saving: editor.saving,
    });

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
