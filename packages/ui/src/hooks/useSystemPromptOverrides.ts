import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SystemPromptOverrideKey } from "@zcode/shared";
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
  baseline: string;
  draft: string;
  saving: boolean;
}

export interface SystemPromptOverridesView {
  hostKey: string;
  isRemote: boolean;
  status: SystemPromptOverridesStatus;
  sections: readonly EditableSystemPromptSection[];
  editor: SystemPromptEditorState | null;
  editorDirty: boolean;
  canSaveEditor: boolean;
  reload: () => void;
  openEditor: (key: SystemPromptOverrideKey, effectiveContent: string) => void;
  closeEditor: () => void;
  setDraft: (draft: string) => void;
  saveEditor: () => Promise<void>;
  restoreDefault: (key: SystemPromptOverrideKey) => Promise<void>;
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
  const loadVersionRef = useRef(0);
  const loadedHostKeyRef = useRef<string | null>(null);

  const resetForHost = useCallback(() => {
    loadVersionRef.current += 1;
    loadedHostKeyRef.current = null;
    setSections([]);
    setEditor(null);
    setStatus("loading");
  }, []);

  const load = useCallback(async (key: string, targetService = serviceRef.current) => {
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setStatus("loading");
    try {
      const result = await targetService.listSections();
      if (loadVersionRef.current !== version) return;
      loadedHostKeyRef.current = key;
      setSections(orderedEditableSystemPromptSections(result.sections));
      setStatus("ready");
    } catch (error) {
      if (loadVersionRef.current !== version) return;
      setSections([]);
      const unsupported = isUnknownChannelError(error);
      setStatus(unsupported ? "unsupported" : "failed");
      logger.warn("[SystemPrompt] Failed to load prompt overrides", {
        unsupported,
        error: errorMessage(error),
      });
    }
  }, []);

  useEffect(() => {
    if (loadedHostKeyRef.current === hostKey) return;
    resetForHost();
    if (!rpcReady) {
      setStatus("waiting");
      return;
    }
    void load(hostKey);
  }, [hostKey, load, resetForHost, rpcReady]);

  const reload = useCallback(() => {
    if (!rpcReady) return;
    loadedHostKeyRef.current = null;
    void load(hostKey);
  }, [hostKey, load, rpcReady]);

  const openEditor = useCallback((key: SystemPromptOverrideKey, effectiveContent: string) => {
    setEditor({ key, baseline: effectiveContent, draft: effectiveContent, saving: false });
  }, []);

  const closeEditor = useCallback(() => setEditor(null), []);

  const setDraft = useCallback((draft: string) => {
    setEditor((current) => (current ? { ...current, draft } : current));
  }, []);

  const saveEditor = useCallback(async () => {
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
    const targetService = serviceRef.current;
    setEditor({ ...current, saving: true });
    try {
      await targetService.writeOverride({ key: current.key, content: current.draft });
      if (loadedHostKeyRef.current !== key) return;
      toast(intl.formatMessage({ id: "settings.systemPrompt.saved" }));
      setEditor(null);
      loadedHostKeyRef.current = null;
      await load(key, targetService);
    } catch (error) {
      if (loadedHostKeyRef.current !== key) return;
      logger.warn("[SystemPrompt] Failed to save prompt override", {
        key: current.key,
        error: errorMessage(error),
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
      setEditor((latest) => (latest ? { ...latest, saving: false } : latest));
    }
  }, [editor, hostKey, intl, load, rpcReady]);

  const restoreDefault = useCallback(
    async (key: SystemPromptOverrideKey) => {
      if (!rpcReady) return;
      const host = hostKey;
      const targetService = serviceRef.current;
      try {
        await targetService.deleteOverride({ key });
        if (loadedHostKeyRef.current !== host) return;
        toast(intl.formatMessage({ id: "settings.systemPrompt.restored" }));
        if (editor?.key === key) setEditor(null);
        loadedHostKeyRef.current = null;
        await load(host, targetService);
      } catch (error) {
        if (loadedHostKeyRef.current !== host) return;
        logger.warn("[SystemPrompt] Failed to restore prompt default", {
          key,
          error: errorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.systemPrompt.restoreFailed" }));
      }
    },
    [editor?.key, hostKey, intl, load, rpcReady],
  );

  const effectiveStatus: SystemPromptOverridesStatus = rpcReady ? status : "waiting";
  const editorDirty = editor !== null && isSystemPromptDraftDirty(editor.baseline, editor.draft);
  const canSaveEditor =
    editor !== null &&
    effectiveStatus === "ready" &&
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
    canSaveEditor,
    reload,
    openEditor,
    closeEditor,
    setDraft,
    saveEditor,
    restoreDefault,
  };
}
