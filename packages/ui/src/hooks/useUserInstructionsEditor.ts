import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UserInstructionsReadResult } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  canSaveUserInstructions,
  getUserInstructionsHostKey,
  hasClaudeAtImports,
  isRemoteUserInstructionsTarget,
  isUnknownChannelError,
  isUserInstructionsDraftDirty,
  resolveUserInstructionsEditorStatus,
  type UserInstructionsHostTarget,
  type UserInstructionsLoadedFile,
} from "@/settings/userInstructionsEditorModel.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

export type UserInstructionsReadError = Extract<UserInstructionsReadResult, { kind: "error" }>;

export type UserInstructionsEditorStatus =
  | "waiting"
  | "loading"
  | "ready"
  | "readError"
  | "unsupported"
  | "failed";

export interface UserInstructionsEditor {
  hostKey: string;
  isRemote: boolean;
  status: UserInstructionsEditorStatus;
  loaded: UserInstructionsLoadedFile | null;
  readError: UserInstructionsReadError | null;
  draft: string;
  setDraft: (draft: string) => void;
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  claudeImportAvailable: boolean;
  conflict: { currentRevision: string | null } | null;
  reload: () => void;
  save: () => Promise<void>;
  resolveConflict: (choice: "reload" | "overwrite" | "keep") => Promise<void>;
  importFromClaude: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 全局指令编辑器状态的唯一所有者（loaded + draft + 冲突）。
 * 事实源是目标主机磁盘上的 ~/.zcode/AGENTS.md；这里不缓存、不广播。
 * 目标主机由调用方传入的 target 决定：本机走窗口级 base Host，远端走 workspace 连接。
 */
export function useUserInstructionsEditor(
  target: UserInstructionsHostTarget,
): UserInstructionsEditor {
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
  // 远端目标必须等 resolution 也确认是远端且连接就绪；否则拿到的是当前 context 服务，
  // 可能是本机 Host，会静默编辑本机文件。
  const rpcReady = isRemote ? resolution.isRemoteTarget && resolution.rpcReady : true;
  const service = isRemote
    ? resolution.services.userInstructionsService
    : baseServices.userInstructionsService;
  // 同一主机重连会替换服务实例；通过 ref 读取最新实例，避免因实例变化重载并丢弃草稿。
  const serviceRef = useRef(service);
  useLayoutEffect(() => {
    serviceRef.current = service;
  }, [service]);

  const [status, setStatus] = useState<UserInstructionsEditorStatus>("loading");
  const [loaded, setLoaded] = useState<UserInstructionsLoadedFile | null>(null);
  const [readError, setReadError] = useState<UserInstructionsReadError | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [claudeImportAvailable, setClaudeImportAvailable] = useState(false);
  const [conflict, setConflict] = useState<{ currentRevision: string | null } | null>(null);
  const loadVersionRef = useRef(0);
  // 仅在读取 RPC 成功返回后记录；失败时保持 null，连接恢复后可自动重试。
  const loadedHostKeyRef = useRef<string | null>(null);

  const resetForHost = useCallback(() => {
    loadVersionRef.current += 1;
    loadedHostKeyRef.current = null;
    setLoaded(null);
    setReadError(null);
    setDraft("");
    setConflict(null);
    setClaudeImportAvailable(false);
  }, []);

  const load = useCallback(async (key: string) => {
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setStatus("loading");
    const currentService = serviceRef.current;
    try {
      const [result, importSource] = await Promise.all([
        currentService.read(),
        currentService.readClaudeImportSource().catch(() => null),
      ]);
      if (loadVersionRef.current !== version) return;
      loadedHostKeyRef.current = key;
      setConflict(null);
      setClaudeImportAvailable(importSource !== null && importSource.kind !== "missing");
      if (result.kind === "ok") {
        setLoaded(result);
        setReadError(null);
        setDraft(result.content);
        setStatus("ready");
      } else {
        setLoaded(null);
        setReadError(result);
        setDraft("");
        setStatus("readError");
      }
    } catch (error) {
      if (loadVersionRef.current !== version) return;
      setLoaded(null);
      setReadError(null);
      setDraft("");
      const unsupported = isUnknownChannelError(error);
      setStatus(unsupported ? "unsupported" : "failed");
      logger.warn("[UserInstructions] Failed to read global instructions", {
        unsupported,
        error: errorMessage(error),
      });
    }
  }, []);

  useEffect(() => {
    if (loadedHostKeyRef.current === hostKey) {
      // 同一主机重连（remoteSessionId / 服务实例变化）不重载，草稿保持。
      return;
    }
    resetForHost();
    if (!rpcReady) {
      setStatus("waiting");
      return;
    }
    void load(hostKey);
  }, [hostKey, load, resetForHost, rpcReady]);

  // 展示状态由 rpcReady 派生：断线即使已加载过文件也显示 waiting，草稿仍保留在 state 中。
  const effectiveStatus = resolveUserInstructionsEditorStatus({ status, rpcReady });
  const dirty = isUserInstructionsDraftDirty(loaded, draft);
  const canSave = effectiveStatus === "ready" && canSaveUserInstructions({ loaded, draft, saving });

  const reload = useCallback(() => {
    if (!rpcReady) return;
    resetForHost();
    void load(hostKey);
  }, [hostKey, load, resetForHost, rpcReady]);

  const write = useCallback(
    async (expectedRevision: string | null) => {
      // 断线时服务代理已失效，不能再发起写入。
      if (!loaded || !rpcReady) return;
      const key = hostKey;
      const content = draft;
      setSaving(true);
      try {
        const result = await serviceRef.current.write({
          content,
          expectedRevision,
          eol: loaded.eol,
          hasBom: loaded.hasBom,
        });
        // 保存期间目标主机已切换：结果属于旧主机，不能覆盖新主机的状态。
        if (loadedHostKeyRef.current !== key) return;
        if (result.kind === "ok") {
          setLoaded({
            ...loaded,
            state: "file",
            content,
            revision: result.revision,
            sizeBytes: result.sizeBytes,
            mixedLineEndings: false,
          });
          toast(intl.formatMessage({ id: "settings.instructions.saved" }));
        } else if (result.kind === "conflict") {
          setConflict({ currentRevision: result.currentRevision });
        } else {
          logger.warn("[UserInstructions] Saving global instructions was rejected", {
            code: result.code,
            message: result.message,
          });
          toast(
            intl.formatMessage({ id: "settings.instructions.saveFailed" }, { code: result.code }),
          );
        }
      } catch (error) {
        logger.warn("[UserInstructions] Failed to save global instructions", {
          error: errorMessage(error),
        });
        toast(
          intl.formatMessage({
            id: isUnknownChannelError(error)
              ? "settings.instructions.unsupportedHost"
              : "settings.instructions.saveFailedGeneric",
          }),
        );
      } finally {
        setSaving(false);
      }
    },
    [draft, hostKey, intl, loaded, rpcReady],
  );

  const save = useCallback(async () => {
    if (!canSave || !loaded) return;
    await write(loaded.revision);
  }, [canSave, loaded, write]);

  const resolveConflict = useCallback(
    async (choice: "reload" | "overwrite" | "keep") => {
      const current = conflict;
      setConflict(null);
      if (!current || choice === "keep") return;
      if (choice === "reload") {
        reload();
        return;
      }
      await write(current.currentRevision);
    },
    [conflict, reload, write],
  );

  const importFromClaude = useCallback(async () => {
    if (!rpcReady) return;
    const key = hostKey;
    try {
      const source = await serviceRef.current.readClaudeImportSource();
      if (loadedHostKeyRef.current !== key) return;
      if (source.kind === "missing") {
        setClaudeImportAvailable(false);
        toast(intl.formatMessage({ id: "settings.instructions.import.missing" }));
        return;
      }
      if (source.kind === "error") {
        toast(
          intl.formatMessage({ id: "settings.instructions.import.failed" }, { code: source.code }),
        );
        return;
      }
      if (dirty && draft.trim() !== "") {
        const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
          title: intl.formatMessage({ id: "settings.instructions.import.confirmTitle" }),
          description: intl.formatMessage({
            id: "settings.instructions.import.confirmDescription",
          }),
          confirmLabel: intl.formatMessage({ id: "settings.instructions.import.confirmAction" }),
          confirmVariant: "destructive",
        });
        if (!confirmed || loadedHostKeyRef.current !== key) return;
      }
      setDraft(source.content);
      toast(
        intl.formatMessage({
          id: hasClaudeAtImports(source.content)
            ? "settings.instructions.import.doneWithAtImports"
            : "settings.instructions.import.done",
        }),
      );
    } catch (error) {
      logger.warn("[UserInstructions] Failed to read CLAUDE.md", { error: errorMessage(error) });
      toast(intl.formatMessage({ id: "settings.instructions.import.failedGeneric" }));
    }
  }, [dirty, draft, hostKey, intl, rpcReady]);

  return {
    hostKey,
    isRemote,
    status: effectiveStatus,
    loaded,
    readError,
    draft,
    setDraft,
    dirty,
    canSave,
    saving,
    claudeImportAvailable,
    conflict,
    reload,
    save,
    resolveConflict,
    importFromClaude,
  };
}
