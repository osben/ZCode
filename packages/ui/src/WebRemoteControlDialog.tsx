import { memo, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
/* eslint-disable max-lines -- The Web remote-control dialog handles startup, status polling, QR codes, and error messages in one place; split it into subcomponents once the behavior stabilizes. */
import type { BotProvider, WebRemoteControlFailure, WebRemoteControlStatus } from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import {
  Bot as BotIcon,
  CopyIcon,
  LoaderCircle,
  MonitorSmartphone,
  RefreshCw,
  Smartphone,
  Unplug,
  XIcon,
} from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<BotProvider, "weixin" | "feishu" | "lark" | "telegram">;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

export function isSameWebRemoteControlTarget(
  status: WebRemoteControlStatus,
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string,
): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: this previously treated any existing sessionId as the “same target,” potentially
  // reusing an old session from another workspace. Opening the dialog for the current workspace
  // then skipped startup and remained stuck in starting. Compare workspaceKey (identity first)
  // and remoteSessionId strictly so each session matches its target.
  const statusWorkspacePath = status.workspacePath?.trim();
  if (!statusWorkspacePath) {
    return false;
  }

  const expectedWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath,
    workspaceIdentity,
  });
  const statusWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: statusWorkspacePath,
    workspaceIdentity: status.workspaceIdentity,
  });
  if (statusWorkspaceKey !== expectedWorkspaceKey) {
    return false;
  }

  const expectedRemoteSessionId = remoteSessionId?.trim() || undefined;
  const statusRemoteSessionId = status.remoteSessionId?.trim() || undefined;
  if (statusRemoteSessionId !== expectedRemoteSessionId) {
    return false;
  }

  return Boolean(status.windowControlSessionId ?? status.sessionId);
}

export function isReusableWebRemoteControlSession(status: WebRemoteControlStatus): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: opening the desktop dialog only views/manages the window-level remote-control entry
  // point. Do not restart the device relay session because the desktop workspace differs from the
  // workspace already bridged to the phone; that would send desktop-disconnected to the phone.
  // Reuse across workspaces only for sessions already connected to a phone, so an old, unconnected
  // QR code cannot send a newly scanned user to the previous default workspace.
  return Boolean(status.mobileConnected && (status.windowControlSessionId ?? status.sessionId));
}

function getStatusLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.status.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.status.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.status.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.status.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.status.error" });
    default:
      return formatMessage({ id: "webRemoteControl.status.idle" });
  }
}

function getStatusDetail(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.statusDetail.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.statusDetail.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.statusDetail.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.statusDetail.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.statusDetail.error" });
    default:
      return formatMessage({ id: "webRemoteControl.statusDetail.idle" });
  }
}

function getStatusDotClassName(status: WebRemoteControlStatus): string {
  if (status.status === "error") {
    return "bg-destructive";
  }
  if (status.status === "active") {
    return "bg-success";
  }
  if (status.status === "idle") {
    return "bg-border";
  }
  return "bg-warning";
}

export function getWebRemoteControlStatusTagLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  const deviceName =
    status.mobileDeviceInfo?.browserPlatform?.trim() || status.mobileDeviceInfo?.name?.trim();

  if (deviceName) {
    return deviceName;
  }

  if (status.mobileConnected) {
    return formatMessage({ id: "webRemoteControl.statusTag.phone" });
  }

  if (status.status === "idle") {
    return formatMessage({ id: "webRemoteControl.status.idle" });
  }

  if (status.status === "error") {
    return formatMessage({ id: "webRemoteControl.status.error" });
  }

  return formatMessage({ id: "webRemoteControl.statusTag.ready" });
}

function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.deviceToken === right.deviceToken &&
    left.expiresAt === right.expiresAt &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.qrUrl === right.qrUrl &&
    left.connectUrl === right.connectUrl &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.remoteSessionId === right.remoteSessionId &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

function getFailureDescription(
  failure: WebRemoteControlFailure | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string | null {
  if (!failure) {
    return null;
  }

  switch (failure.reason) {
    case "session-not-found":
      return formatMessage({ id: "webRemoteControl.failure.sessionNotFound" });
    case "session-expired":
      return formatMessage({ id: "webRemoteControl.failure.sessionExpired" });
    case "session-conflict":
      if (failure.message?.toLowerCase().includes("kicked")) {
        return formatMessage({ id: "webRemoteControl.failure.kicked" });
      }
      return formatMessage({ id: "webRemoteControl.failure.sessionConflict" });
    case "workspace-closed":
      return formatMessage({ id: "webRemoteControl.failure.workspaceClosed" });
    case "desktop-disconnected":
      return formatMessage({
        id: "webRemoteControl.failure.desktopDisconnected",
      });
    case "invalid-mobile-connection":
      return formatMessage({
        id: "webRemoteControl.failure.invalidMobileConnection",
      });
    case "desktop-bootstrap-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.desktopBootstrapTimeout",
      });
    case "connection-recovery-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.connectionRecoveryTimeout",
      });
    case "relay-unavailable":
      return formatMessage({ id: "webRemoteControl.failure.relayUnavailable" });
    case "unsupported-action":
      return formatMessage({
        id: "webRemoteControl.failure.unsupportedAction",
      });
    case "unexpected-error":
      return formatMessage({ id: "webRemoteControl.failure.unexpectedError" });
  }
}

export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}) {
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<WebRemoteControlStatus>({
    status: "idle",
  });
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] = useState<RemoteControlBotProvider | null>(null);

  const statusLabel = useMemo(
    () => getStatusLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDetail = useMemo(
    () => getStatusDetail(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const failureDescription = useMemo(
    () => getFailureDescription(status.failure, intl.formatMessage),
    [intl.formatMessage, status.failure],
  );
  const statusTagLabel = useMemo(
    () => getWebRemoteControlStatusTagLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDotClassName = getStatusDotClassName(status);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const syncWebRemoteControlStatus = async () => {
      setLoading(true);

      try {
        const currentStatus = await platform.getWebRemoteControlStatus();
        let nextStatus: WebRemoteControlStatus;
        if (
          isSameWebRemoteControlTarget(
            currentStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(currentStatus)
        ) {
          nextStatus = currentStatus;
        } else {
          const startResult = await platform.startWebRemoteControl({
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            initialTaskId,
          });
          // Support platform implementations that can still return cancelled; current Desktop no longer adds a native confirmation.
          nextStatus = startResult.status === "cancelled" ? { status: "idle" } : startResult;
        }
        // Bugfix: mobile now uses dark as its default theme and no longer relies on the QR URL to
        // pass through theme. Remove theme from startup parameters so the desktop theme does not
        // unnecessarily affect the remote-control flow.

        if (!cancelled) {
          setStatus(nextStatus);
          logger.info("[WebRemoteControlDialog] Web 远程控制状态已同步", {
            workspacePath,
            workspaceIdentity: workspaceIdentity ?? "none",
            remoteSessionId: remoteSessionId ?? "none",
            initialTaskId: initialTaskId ?? "none",
            status: nextStatus.status,
            sessionId: nextStatus.sessionId ?? "none",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setStatus({
            status: "error",
            workspacePath,
            remoteSessionId,
            error: message,
          });
          toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
        }
        logger.error("[WebRemoteControlDialog] 启动 Web 远程控制失败", {
          workspacePath,
          workspaceIdentity: workspaceIdentity ?? "none",
          remoteSessionId: remoteSessionId ?? "none",
          initialTaskId: initialTaskId ?? "none",
          error: message,
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void syncWebRemoteControlStatus();

    return () => {
      cancelled = true;
    };
  }, [intl, open, platform, remoteSessionId, workspaceIdentity, workspacePath, initialTaskId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const pollWebRemoteControlStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        if (cancelled) {
          return;
        }

        const shouldApplyStatus =
          isSameWebRemoteControlTarget(
            nextStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(nextStatus) ||
          nextStatus.status === "idle" ||
          nextStatus.status === "error";
        if (!shouldApplyStatus) {
          return;
        }

        setStatus((currentStatus) =>
          isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
        );
      } catch {
        // Bugfix: Web remote-control state changes on the main/relay side. If the dialog syncs only
        // once when opened, it can remain stuck at “Waiting for connection.” Use lightweight
        // polling to refresh state; ignore an individual failure so it does not interrupt the user.
      }
    };

    const intervalId = window.setInterval(() => {
      void pollWebRemoteControlStatus();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [open, platform, remoteSessionId, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!status.qrUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    setQrDataUrl(null);

    void QRCode.toDataURL(status.qrUrl, {
      margin: 1,
      width: 320,
    })
      .then((dataUrl: string) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[WebRemoteControlDialog] 生成二维码失败", message);
      });

    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  const handleCopyLink = async () => {
    if (!status.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(status.connectUrl);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLink.copied" }));
      logger.info("[WebRemoteControlDialog] 已复制 Web 远程控制链接", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        sessionId: status.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLinkFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] 复制 Web 远程控制链接失败", message);
    }
  };

  const handleRefreshQr = async () => {
    // Bugfix: refreshing the QR code invalidates previously copied or scanned sid/hash links. The
    // button used to sit beside Copy link, so an accidental click immediately invalidated a link
    // already sent to a phone; use the shared confirmation dialog first.
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "webRemoteControl.refreshQr.confirmTitle" }),
      description: intl.formatMessage({
        id: "webRemoteControl.refreshQr.confirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "webRemoteControl.refreshQr" }),
    });
    if (!confirmed) {
      return;
    }

    setLoading(true);
    try {
      const nextStatus = await platform.refreshWebRemoteControlPairing({
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        initialTaskId,
      });
      if (nextStatus.status === "cancelled") {
        // For cancellable platform implementations, keep the current state and show no success or failure feedback.
        return;
      }
      // Bugfix: an exposed old QR code contains sid/hash; merely redrawing the image only changes
      // its timestamp. Use the platform reset so main clears persisted pairing material before
      // registering the relay device again.
      setStatus(nextStatus);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.success" }));
      logger.info("[WebRemoteControlDialog] 已刷新 Web 远程控制二维码", {
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? "none",
        remoteSessionId: remoteSessionId ?? "none",
        initialTaskId: initialTaskId ?? "none",
        sessionId: nextStatus.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.failed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] 刷新 Web 远程控制二维码失败", {
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? "none",
        remoteSessionId: remoteSessionId ?? "none",
        initialTaskId: initialTaskId ?? "none",
        error: message,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await platform.stopWebRemoteControl();
      setStatus({ status: "idle" });
      onOpenChange(false);
      toast(intl.formatMessage({ id: "webRemoteControl.stopSuccess" }));
      logger.info("[WebRemoteControlDialog] 已关闭 Web 远程控制", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.stopFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] 关闭 Web 远程控制失败", message);
    } finally {
      setLoading(false);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    logger.info("[WebRemoteControlDialog] 弹层开关状态变化", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      nextOpen,
    });
    onOpenChange(nextOpen);
  };

  const handleDismiss = () => {
    logger.info("[WebRemoteControlDialog] 用户点击右上角关闭按钮", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      sessionId: status.sessionId ?? "none",
      status: status.status,
    });
    handleDialogOpenChange(false);
  };

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bot Channel 配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bots 总配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          showCloseButton={false}
          // Bugfix: the Mobile Remote Control dialog used to be wider and closer to the window edge
          // than Remote Connect, making startup QR and Bot Channel content feel visually inconsistent.
          // Reuse Remote Connect's outer dimensions without forcing full height; remote-control
          // content is shorter, so sizing to content prevents an empty-looking dialog.
          className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bug fix: This dialog appears near the top of the desktop window, where the default close button can be hard to click inside Electron’s drag region.
            // Use an explicit click-to-close action and mark the button itself no-drag so the upper-right close action is reliably clickable.
            // Bug fix: Clickable controls in the remote-control popover previously lacked an explicit pointer cursor and did not look interactive on desktop hover.
            // Add the pointer cursor only when enabled; disabled controls keep the Button’s disabled interaction semantics.
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={handleDismiss}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
          <div
            data-testid="web-remote-control-dialog-scroll"
            className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5"
          >
            <DialogHeader className="space-y-2 pr-8">
              <div className="flex items-center gap-2">
                <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                  <MonitorSmartphone className="size-5" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>{intl.formatMessage({ id: "webRemoteControl.title" })}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "webRemoteControl.description" })}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div
              data-testid="web-remote-control-main-grid"
              className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]"
            >
              <section
                data-testid="web-remote-control-scan-card"
                className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4"
              >
                <div className="mb-4 flex items-start gap-2">
                  <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.mobileQr.title",
                      })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.mobileQr.description",
                      })}
                    </p>
                  </div>
                </div>
                <div
                  data-testid="web-remote-control-connection-card"
                  className="mb-3 rounded-lg bg-surface px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="text-ui-base font-medium text-foreground">
                          {statusLabel}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                          <span
                            className={`size-1.5 shrink-0 rounded-full ${statusDotClassName}`}
                          />
                          <span className="truncate">{statusTagLabel}</span>
                        </div>
                      </div>
                      <div className="text-ui-base/relaxed text-foreground-subtle">
                        {statusDetail}
                      </div>
                    </div>
                    {loading ? (
                      <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        className="shrink-0 gap-2 enabled:cursor-pointer"
                        onClick={() => void handleStop()}
                        disabled={status.status === "idle"}
                      >
                        <Unplug className="size-3.5" />
                        {intl.formatMessage({ id: "webRemoteControl.stop" })}
                      </Button>
                    )}
                  </div>
                  {failureDescription ? (
                    <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-ui-base/relaxed text-destructive">
                      <p>{failureDescription}</p>
                      {status.failure?.message && status.failure.message !== failureDescription ? (
                        <p className="mt-1 text-ui-xs/relaxed opacity-80">
                          {status.failure.message}
                        </p>
                      ) : null}
                    </div>
                  ) : status.error ? (
                    <p className="mt-3 text-ui-base/relaxed text-destructive">{status.error}</p>
                  ) : null}
                  <div
                    data-testid="web-remote-control-copy-link-row"
                    className="mt-3 flex min-h-10 flex-wrap items-center gap-3 border-t border-border pt-3"
                  >
                    <div className="min-w-48 flex-1 text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.copyLink.description",
                      })}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      className="shrink-0 gap-2 enabled:cursor-pointer"
                      onClick={() => void handleRefreshQr()}
                      disabled={loading}
                    >
                      <RefreshCw className="size-3.5" />
                      {intl.formatMessage({ id: "webRemoteControl.refreshQr" })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      className="shrink-0 gap-2 enabled:cursor-pointer"
                      onClick={() => void handleCopyLink()}
                      disabled={!status.connectUrl || loading}
                    >
                      <CopyIcon className="size-3.5" />
                      {intl.formatMessage({ id: "webRemoteControl.copyLink" })}
                    </Button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background-alt p-4">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
                      className="size-64 max-w-full rounded-lg bg-white p-3"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-center text-ui-base text-foreground-subtle">
                      <LoaderCircle className="size-5 animate-spin" />
                      <span>
                        {intl.formatMessage({
                          id: "webRemoteControl.generating",
                        })}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-4 flex items-start gap-2">
                  <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.title",
                      })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.description",
                      })}
                    </p>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 gap-3">
                  {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
                    const regionTagLabelId = getBotProviderRegionTagLabelId(entry.provider);

                    return (
                      <button
                        key={entry.provider}
                        type="button"
                        className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                        onClick={() => handleOpenBotEntry(entry.provider)}
                      >
                        {/* Bug fix: The remote-control Bot Channel entry used a generic Lucide icon, so users could not distinguish WeChat, Feishu, and Telegram at a glance.
                            Reuse the channel logos from BotsDialog directly without an extra wrapper, so the brand icon itself provides recognition. */}
                        <ProviderIcon provider={entry.provider} className="size-12 shrink-0" />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                            <span className="min-w-0 truncate">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${entry.provider}.title`,
                              })}
                            </span>
                            {regionTagLabelId ? (
                              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                {intl.formatMessage({ id: regionTagLabelId })}
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-ui-base/relaxed text-foreground-subtle">
                            {intl.formatMessage({
                              id: `webRemoteControl.botChannel.${entry.provider}.description`,
                            })}
                          </span>
                          <span className="block text-ui-base font-medium text-primary">
                            {intl.formatMessage({
                              id: "webRemoteControl.botChannel.configure",
                            })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    data-testid="web-remote-control-open-bots"
                    className="w-full justify-center gap-2 enabled:cursor-pointer"
                    onClick={handleOpenBotsDialog}
                  >
                    <BotIcon className="size-3.5" />
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.manageBots",
                    })}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
