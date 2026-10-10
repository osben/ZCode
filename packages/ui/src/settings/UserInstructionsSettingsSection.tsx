import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Monitor, RotateCcw, Server } from "lucide-react";
import {
  TID_SETTINGS_INSTRUCTIONS_CONFLICT_DIALOG,
  TID_SETTINGS_INSTRUCTIONS_CONFLICT_OVERWRITE,
  TID_SETTINGS_INSTRUCTIONS_CONFLICT_RELOAD,
  TID_SETTINGS_INSTRUCTIONS_DESKTOP_ONLY,
  TID_SETTINGS_INSTRUCTIONS_HOST,
  TID_SETTINGS_INSTRUCTIONS_RETRY,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  useUserInstructionsEditor,
  type UserInstructionsEditor,
} from "@/hooks/useUserInstructionsEditor.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceHeaderHostLabel } from "@/lib/remoteWorkspaceHistory.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  UserInstructionsReadyEditor,
  UserInstructionsRevealButton,
} from "@/settings/UserInstructionsReadyEditor.js";
import {
  formatUserInstructionsBytes,
  getUserInstructionsHostKey,
  type UserInstructionsHostTarget,
} from "@/settings/userInstructionsEditorModel.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

interface UserInstructionsSettingsSectionProps {
  isDesktop: boolean;
  /** 当前活动 workspace 对应的目标主机；无 workspace 时 workspacePath 为 null（本机）。 */
  activeTarget: UserInstructionsHostTarget;
  /** 只向设置页暴露"是否存在脏草稿"，用于导航拦截；草稿内容仍由本分区持有。 */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * 设置页「指令」分区：编辑目标主机上的全局 ~/.zcode/AGENTS.md。
 * 仅 Desktop 提供；Web / 手机远控显示占位，不加载文件。
 */
export function UserInstructionsSettingsSection({
  isDesktop,
  activeTarget,
  onDirtyChange,
}: UserInstructionsSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  if (!isDesktop) {
    return (
      <div className="space-y-3">
        <SectionDescription />
        <div
          data-testid={TID_SETTINGS_INSTRUCTIONS_DESKTOP_ONLY}
          className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.instructions.desktopOnly" })}
        </div>
      </div>
    );
  }
  return (
    <DesktopUserInstructionsEditor activeTarget={activeTarget} onDirtyChange={onDirtyChange} />
  );
}

function SectionDescription() {
  const { intl } = useZCodeIntl();
  return (
    <div className="text-ui-base font-medium text-foreground-subtle">
      {intl.formatMessage({ id: "settings.instructions.description" })}
    </div>
  );
}

function DesktopUserInstructionsEditor({
  activeTarget,
  onDirtyChange,
}: {
  activeTarget: UserInstructionsHostTarget;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // 编辑器绑定的主机：有脏草稿时活动 workspace 切到另一台主机，草稿不能被"带"过去写错文件。
  const [pinnedTarget, setPinnedTarget] = useState(activeTarget);
  const editor = useUserInstructionsEditor(pinnedTarget);
  const activeHostKey = getUserInstructionsHostKey(activeTarget);
  const pinnedHostKey = editor.hostKey;
  const declinedHostKeyRef = useRef<string | null>(null);
  const editorDirty = editor.dirty;
  // 弹窗期间 activeTarget 可能只换了引用（如 remoteSessionId 更新）；确认后应采用最新目标。
  const activeTargetRef = useRef(activeTarget);
  useLayoutEffect(() => {
    activeTargetRef.current = activeTarget;
  }, [activeTarget]);

  useEffect(() => {
    if (activeHostKey === pinnedHostKey) {
      // 同一主机只更新连接元数据（如 remoteSessionId），不弹窗也不丢草稿。
      declinedHostKeyRef.current = null;
      setPinnedTarget(activeTarget);
      return;
    }
    if (!editorDirty) {
      declinedHostKeyRef.current = null;
      setPinnedTarget(activeTarget);
      return;
    }
    // 对同一个新主机只询问一次；用户取消后编辑器继续指向原主机，直到保存或放弃。
    if (declinedHostKeyRef.current === activeHostKey) return;
    declinedHostKeyRef.current = activeHostKey;
    const requestedHostKey = activeHostKey;
    void useConfirmDialogStore
      .getState()
      .requestConfirmation({
        title: intl.formatMessage({ id: "settings.instructions.discard.title" }),
        description: intl.formatMessage({ id: "settings.instructions.discard.hostChanged" }),
        confirmLabel: intl.formatMessage({ id: "settings.instructions.discard.confirm" }),
        confirmVariant: "destructive",
      })
      .then((confirmed) => {
        const latest = activeTargetRef.current;
        // 弹窗期间活动主机又变了：本次回答针对的是旧主机，忽略，由 effect 重新询问。
        if (!confirmed || getUserInstructionsHostKey(latest) !== requestedHostKey) return;
        declinedHostKeyRef.current = null;
        setPinnedTarget(latest);
      });
  }, [activeHostKey, activeTarget, editorDirty, intl, pinnedHostKey]);

  useEffect(() => {
    onDirtyChange(editorDirty);
  }, [editorDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  return (
    <div className="space-y-3">
      <SectionDescription />
      {activeHostKey !== pinnedHostKey ? (
        <Alert variant="warning">
          <AlertDescription>
            {intl.formatMessage(
              { id: "settings.instructions.pinnedHostNotice" },
              { host: formatHostLabel(pinnedTarget, intl) },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <SettingsGroupCard>
        <div className="space-y-3 px-4 py-3">
          <HostHeader target={pinnedTarget} editor={editor} />
          <EditorBody editor={editor} />
        </div>
      </SettingsGroupCard>
      <p className="text-ui-sm leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.instructions.effectHint" })}
      </p>
      <ConflictDialog editor={editor} />
    </div>
  );
}

type Intl = ReturnType<typeof useZCodeIntl>["intl"];

function formatHostLabel(target: UserInstructionsHostTarget, intl: Intl): string {
  if (getUserInstructionsHostKey(target) === "local") {
    return intl.formatMessage({ id: "settings.instructions.host.local" });
  }
  if (target.remoteTarget) return formatRemoteWorkspaceHeaderHostLabel(target.remoteTarget);
  return target.workspaceIdentity?.trim() || target.workspacePath || "";
}

function HostHeader({
  target,
  editor,
}: {
  target: UserInstructionsHostTarget;
  editor: UserInstructionsEditor;
}) {
  const { intl } = useZCodeIntl();
  const path = editor.loaded?.path ?? editor.readError?.path;
  const linkTarget = editor.loaded?.linkTarget ?? editor.readError?.linkTarget;
  const HostIcon = editor.isRemote ? Server : Monitor;
  return (
    <div className="space-y-1">
      <div
        className="flex items-center gap-2 text-ui-base font-medium text-foreground"
        data-testid={TID_SETTINGS_INSTRUCTIONS_HOST}
      >
        <HostIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <span className="truncate">{formatHostLabel(target, intl)}</span>
      </div>
      {path ? (
        <div className="break-all font-mono text-ui-sm text-foreground-subtle">{path}</div>
      ) : null}
      {linkTarget ? (
        <div className="break-all font-mono text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.instructions.linkTarget" }, { target: linkTarget })}
        </div>
      ) : null}
      {target.remoteTarget?.kind === "docker" ? (
        <p className="text-ui-sm leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.instructions.dockerHint" })}
        </p>
      ) : null}
    </div>
  );
}

function EditorBody({ editor }: { editor: UserInstructionsEditor }) {
  const { intl } = useZCodeIntl();
  switch (editor.status) {
    case "waiting":
      return <StatusText id="settings.instructions.waitingRemote" />;
    case "loading":
      return <StatusText id="common.loading" />;
    case "unsupported":
      return <StatusText id="settings.instructions.unsupportedHost" />;
    case "failed":
      return (
        <ErrorWithRetry
          message={intl.formatMessage({ id: "settings.instructions.loadFailed" })}
          onRetry={editor.reload}
        />
      );
    case "readError":
      return <ReadErrorState editor={editor} />;
    case "ready":
      return <UserInstructionsReadyEditor editor={editor} />;
  }
}

function StatusText({ id }: { id: string }) {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">{intl.formatMessage({ id })}</p>
  );
}

function ErrorWithRetry({
  message,
  onRetry,
  extra,
}: {
  message: string;
  onRetry: () => void;
  extra?: React.ReactNode;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-3">
      <p className="text-ui-base leading-6 text-foreground-subtle">{message}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          data-testid={TID_SETTINGS_INSTRUCTIONS_RETRY}
        >
          <RotateCcw className="size-4" />
          {intl.formatMessage({ id: "settings.instructions.retry" })}
        </Button>
        {extra}
      </div>
    </div>
  );
}

function ReadErrorState({ editor }: { editor: UserInstructionsEditor }) {
  const { intl } = useZCodeIntl();
  const error = editor.readError;
  if (!error) return null;
  const message = intl.formatMessage(
    { id: `settings.instructions.error.${error.code}` },
    { size: formatUserInstructionsBytes(error.sizeBytes ?? 0) },
  );
  const revealPath = error.linkTarget ?? error.path;
  return (
    <ErrorWithRetry
      message={message}
      onRetry={editor.reload}
      extra={
        !editor.isRemote && error.code === "TOO_LARGE_TO_EDIT" ? (
          <UserInstructionsRevealButton filePath={revealPath} />
        ) : null
      }
    />
  );
}

function ConflictDialog({ editor }: { editor: UserInstructionsEditor }) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={editor.conflict !== null}
      onOpenChange={(open) => {
        // 关闭弹窗（Esc / 遮罩）保持草稿不变。
        if (!open) void editor.resolveConflict("keep");
      }}
    >
      <AlertDialogContent data-testid={TID_SETTINGS_INSTRUCTIONS_CONFLICT_DIALOG}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "settings.instructions.conflict.title" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.instructions.conflict.description" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
          <Button
            variant="outline"
            onClick={() => void editor.resolveConflict("reload")}
            data-testid={TID_SETTINGS_INSTRUCTIONS_CONFLICT_RELOAD}
          >
            {intl.formatMessage({ id: "settings.instructions.conflict.reload" })}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void editor.resolveConflict("overwrite")}
            data-testid={TID_SETTINGS_INSTRUCTIONS_CONFLICT_OVERWRITE}
          >
            {intl.formatMessage({ id: "settings.instructions.conflict.overwrite" })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
