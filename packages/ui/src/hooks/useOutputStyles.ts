import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OutputStyle } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  canSaveOutputStyleDraft,
  draftFromStyle,
  emptyOutputStyleDraft,
  isOutputStyleConflict,
  isOutputStyleDraftDirty,
  type OutputStyleDraft,
} from "@/settings/outputStylesEditorModel.js";
import {
  getUserInstructionsHostKey,
  isRemoteUserInstructionsTarget,
  isUnknownChannelError,
  type UserInstructionsHostTarget,
} from "@/settings/userInstructionsEditorModel.js";

export type OutputStylesStatus = "waiting" | "loading" | "ready" | "unsupported" | "failed";

export interface OutputStylesEditorState {
  draft: OutputStyleDraft;
  /** Snapshot the editor opened against; null while creating a new style. */
  baseline: OutputStyleDraft | null;
  saving: boolean;
  conflict: { current: OutputStyleDraft } | null;
}

export interface OutputStylesView {
  hostKey: string;
  isRemote: boolean;
  status: OutputStylesStatus;
  styles: readonly OutputStyle[];
  /** Storage directory on the target host (pure lookup; does not create it). */
  stylesDirectory: string | null;
  activeStyleId: string | null;
  activatingStyleId: string | null;
  editor: OutputStylesEditorState | null;
  editorDirty: boolean;
  canSaveEditor: boolean;
  reload: () => void;
  activate: (styleId: string) => Promise<void>;
  openEditor: (style: OutputStyle | "new") => void;
  closeEditor: () => void;
  setDraft: (patch: Partial<Omit<OutputStyleDraft, "styleId">>) => void;
  saveEditor: () => Promise<void>;
  resolveConflict: (choice: "reload" | "overwrite" | "keep") => Promise<void>;
  deleteStyle: (style: OutputStyle) => Promise<void>;
  restoreDefault: (style: OutputStyle) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sole owner of the output-styles settings state (docs/output-styles-settings.md). The source
 * of truth is the target host's ~/.zcode files; the list is reloaded after every write so the
 * UI always shows the effective prompt (constant or override) exactly as the runtime resolves it.
 */
export function useOutputStyles(target: UserInstructionsHostTarget): OutputStylesView {
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
    ? resolution.services.outputStyleService
    : baseServices.outputStyleService;
  const serviceRef = useRef(service);
  useLayoutEffect(() => {
    serviceRef.current = service;
  }, [service]);

  const [status, setStatus] = useState<OutputStylesStatus>("loading");
  const [styles, setStyles] = useState<readonly OutputStyle[]>([]);
  const [stylesDirectory, setStylesDirectory] = useState<string | null>(null);
  const [activeStyleId, setActiveStyleId] = useState<string | null>(null);
  const [activatingStyleId, setActivatingStyleId] = useState<string | null>(null);
  const [editor, setEditor] = useState<OutputStylesEditorState | null>(null);
  const loadVersionRef = useRef(0);
  const loadedHostKeyRef = useRef<string | null>(null);

  const resetForHost = useCallback(() => {
    loadVersionRef.current += 1;
    loadedHostKeyRef.current = null;
    setStyles([]);
    setStylesDirectory(null);
    setActiveStyleId(null);
    setEditor(null);
    setStatus("loading");
  }, []);

  const load = useCallback(async (key: string) => {
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setStatus("loading");
    try {
      const [listResult, activeResult, directoryResult] = await Promise.all([
        serviceRef.current.listStyles(),
        serviceRef.current.getActiveStyle(),
        serviceRef.current.getUserStylesDirectory(),
      ]);
      if (loadVersionRef.current !== version) return;
      loadedHostKeyRef.current = key;
      setStyles(listResult.styles);
      setStylesDirectory(directoryResult.path);
      // listStyles treats a missing settings file as "default" active; mirror that so the
      // fresh-install state shows the Default row checked instead of nothing.
      setActiveStyleId(activeResult.styleId ?? "default");
      setStatus("ready");
    } catch (error) {
      if (loadVersionRef.current !== version) return;
      setStyles([]);
      setStylesDirectory(null);
      setActiveStyleId(null);
      const unsupported = isUnknownChannelError(error);
      setStatus(unsupported ? "unsupported" : "failed");
      logger.warn("[OutputStyles] Failed to load output styles", {
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

  const activate = useCallback(
    async (styleId: string) => {
      if (!rpcReady || activatingStyleId) return;
      const key = hostKey;
      setActivatingStyleId(styleId);
      try {
        await serviceRef.current.setActiveStyle({ styleId });
        if (loadedHostKeyRef.current !== key) return;
        setActiveStyleId(styleId);
        setStyles((current) =>
          current.map((style) => ({ ...style, enabled: style.id === styleId })),
        );
      } catch (error) {
        if (loadedHostKeyRef.current !== key) return;
        logger.warn("[OutputStyles] Failed to activate output style", {
          styleId,
          error: errorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.outputStyles.activateFailed" }));
      } finally {
        setActivatingStyleId(null);
      }
    },
    [activatingStyleId, hostKey, intl, rpcReady],
  );

  const openEditor = useCallback((style: OutputStyle | "new") => {
    setEditor({
      draft: style === "new" ? emptyOutputStyleDraft() : draftFromStyle(style),
      baseline: style === "new" ? null : draftFromStyle(style),
      saving: false,
      conflict: null,
    });
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(null);
  }, []);

  const patchEditor = useCallback((patch: Partial<OutputStylesEditorState>) => {
    setEditor((current) => (current === null ? current : { ...current, ...patch }));
  }, []);

  const setDraft = useCallback((patch: Partial<Omit<OutputStyleDraft, "styleId">>) => {
    setEditor((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...patch } },
    );
  }, []);

  const writeDraft = useCallback(
    async (draft: OutputStyleDraft) => {
      const key = hostKey;
      patchEditor({ saving: true });
      try {
        const config = {
          name: draft.name.trim(),
          description: draft.description.trim(),
          content: draft.content,
        };
        if (draft.styleId === null) {
          await serviceRef.current.addStyle({ config });
        } else {
          await serviceRef.current.updateStyle({ id: draft.styleId, config });
        }
        if (loadedHostKeyRef.current !== key) return;
        toast(intl.formatMessage({ id: "settings.outputStyles.saved" }));
        setEditor(null);
        // Reload so folded built-in overrides and the active flag reflect the written files.
        loadedHostKeyRef.current = null;
        await load(key);
      } catch (error) {
        if (loadedHostKeyRef.current !== key) return;
        logger.warn("[OutputStyles] Failed to save output style", { error: errorMessage(error) });
        toast(intl.formatMessage({ id: "settings.outputStyles.saveFailed" }));
        patchEditor({ saving: false, conflict: null });
      }
    },
    [hostKey, intl, load, patchEditor],
  );

  const saveEditor = useCallback(async () => {
    const current = editor;
    if (current === null || !rpcReady) return;
    const { draft, baseline, saving } = current;
    if (!canSaveOutputStyleDraft({ draft, baseline, saving })) return;
    // Mark saving before the preflight so the editor fields disable and keystrokes typed
    // during the check cannot be lost by the write capturing the older draft.
    patchEditor({ saving: true });
    if (baseline !== null && draft.styleId !== null) {
      // Compare against the disk state at save time, not the snapshot from open. A missing
      // entry means the file was deleted externally since the editor opened — also a conflict,
      // because a plain save would silently recreate it.
      try {
        const listResult = await serviceRef.current.listStyles();
        if (loadedHostKeyRef.current !== hostKey) return;
        const onDisk = listResult.styles.find((style) => style.id === draft.styleId);
        if (!onDisk || isOutputStyleConflict(baseline, draftFromStyle(onDisk))) {
          patchEditor({
            conflict: {
              current: onDisk
                ? draftFromStyle(onDisk)
                : { styleId: draft.styleId, name: "", description: "", content: "" },
            },
            saving: false,
          });
          return;
        }
      } catch (error) {
        logger.warn("[OutputStyles] Failed to re-check style before save", {
          error: errorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.outputStyles.saveFailed" }));
        patchEditor({ saving: false });
        return;
      }
    }
    await writeDraft(draft);
  }, [editor, hostKey, intl, patchEditor, rpcReady, writeDraft]);

  const resolveConflict = useCallback(
    async (choice: "reload" | "overwrite" | "keep") => {
      const current = editor;
      if (current === null || current.conflict === null) return;
      if (choice === "keep") {
        setEditor({ ...current, conflict: null });
        return;
      }
      if (choice === "reload") {
        // Take the disk version as the new baseline but keep the user's draft text so nothing
        // is lost; saving again then diffs against the fresh baseline.
        setEditor({
          ...current,
          baseline: current.conflict.current,
          conflict: null,
        });
        return;
      }
      setEditor({ ...current, conflict: null });
      await writeDraft(current.draft);
    },
    [editor, writeDraft],
  );

  const deleteStyle = useCallback(
    async (style: OutputStyle) => {
      if (!rpcReady) return;
      const key = hostKey;
      try {
        await serviceRef.current.deleteStyle({ id: style.id });
        if (loadedHostKeyRef.current !== key) return;
        if (style.id === activeStyleId) {
          // Best-effort reset: if this write fails after a successful delete, a stale active
          // id remains, which the runtime loader already degrades to "no style". Do not fail
          // the whole operation or report the deletion as failed over the reset.
          try {
            await serviceRef.current.setActiveStyle({ styleId: "default" });
          } catch (error) {
            logger.warn("[OutputStyles] Failed to reset active style after delete", {
              styleId: style.id,
              error: errorMessage(error),
            });
          }
        }
        toast(intl.formatMessage({ id: "settings.outputStyles.deleted" }));
        loadedHostKeyRef.current = null;
        await load(key);
      } catch (error) {
        if (loadedHostKeyRef.current !== key) return;
        logger.warn("[OutputStyles] Failed to delete output style", {
          styleId: style.id,
          error: errorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.outputStyles.deleteFailed" }));
      }
    },
    [activeStyleId, hostKey, intl, load, rpcReady],
  );

  const restoreDefault = useCallback(
    async (style: OutputStyle) => {
      if (!rpcReady) return;
      const key = hostKey;
      try {
        await serviceRef.current.deleteStyle({ id: style.id });
        if (loadedHostKeyRef.current !== key) return;
        toast(intl.formatMessage({ id: "settings.outputStyles.restored" }));
        loadedHostKeyRef.current = null;
        await load(key);
      } catch (error) {
        if (loadedHostKeyRef.current !== key) return;
        logger.warn("[OutputStyles] Failed to restore built-in output style", {
          styleId: style.id,
          error: errorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.outputStyles.restoreFailed" }));
      }
    },
    [hostKey, intl, load, rpcReady],
  );

  const effectiveStatus: OutputStylesStatus = rpcReady ? status : "waiting";
  const editorDirty = editor !== null && isOutputStyleDraftDirty(editor.draft, editor.baseline);
  const canSaveEditor =
    editor !== null &&
    effectiveStatus === "ready" &&
    canSaveOutputStyleDraft({
      draft: editor.draft,
      baseline: editor.baseline,
      saving: editor.saving,
    });

  return {
    hostKey,
    isRemote,
    status: effectiveStatus,
    styles,
    stylesDirectory,
    activeStyleId,
    activatingStyleId,
    editor,
    editorDirty,
    canSaveEditor,
    reload,
    activate,
    openEditor,
    closeEditor,
    setDraft,
    saveEditor,
    resolveConflict,
    deleteStyle,
    restoreDefault,
  };
}
