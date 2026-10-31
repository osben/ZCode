import {
  isSameWebRemoteControlTarget,
  isReusableWebRemoteControlSession,
  getStatusLabel,
  getStatusDetail,
  getStatusDotClassName,
  getWebRemoteControlStatusTagLabel,
  isSameWebRemoteControlStatus,
  getFailureDescription,
} from "@/web-remote-control/domain/presentation.js";
import { memo, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { DesktopCommandIds, type BotProvider, type WebRemoteControlStatus } from "@zcode/shared";
import {
  Bot as BotIcon,
  CopyIcon,
  FileDown,
  LoaderCircle,
  MonitorSmartphone,
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
import { useZCodeStore } from "@/store/StoreProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOAuth } from "@/hooks/useOAuth.js";
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

function WebRemoteControlLoginButton({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { intl } = useZCodeIntl();
  const hasUser = useZCodeStore((state) => Boolean(state.user));
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const { activeProvider, loadingProviders, refreshProviders } = useOAuth();

  return (
    <Button
      type="button"
      data-testid="web-remote-control-login"
      className="enabled:cursor-pointer"
      disabled={loadingProviders}
      onClick={() => {
        // A remote-control 401 does not clear the global user; start a new login attempt scoped to the current channel so the unified entry does not mistake the cached user for success.
        if (hasUser && !activeProvider) {
          toast(intl.formatMessage({ id: "login.oauth.loginFailure" }));
          void refreshProviders();
          return;
        }
        onOpenChange(false);
        requestLoginEntry(activeProvider ?? undefined, "app-login");
      }}
    >
      {intl.formatMessage({ id: "webRemoteControl.authRequired.login" })}
    </Button>
  );
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
    () =>
      status.repairRequired
        ? intl.formatMessage({ id: "webRemoteControl.failure.repairRequired" })
        : getFailureDescription(status.failure, intl.formatMessage),
    [intl.formatMessage, status.failure, status.repairRequired],
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
          currentStatus.status === "auth-required" ||
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
          // Stay compatible with platform implementations that can still return cancelled; current Desktop no longer adds a native confirmation.
          nextStatus = startResult.status === "cancelled" ? { status: "idle" } : startResult;
        }
        // Bugfix: the mobile default theme has converged to dark and no longer relies on the QR URL
        // to pass theme through. Drop theme from the launch params so the desktop theme does not
        // pointlessly participate in the remote-control chain.

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
        const currentStatus = await platform.getWebRemoteControlStatus().catch(() => null);
        if (currentStatus?.status === "auth-required") {
          if (!cancelled) setStatus(currentStatus);
          return;
        }
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
          nextStatus.status === "auth-required" ||
          nextStatus.status === "idle" ||
          nextStatus.status === "error";
        if (!shouldApplyStatus) {
          return;
        }

        setStatus((currentStatus) =>
          isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
        );
      } catch {
        // Bugfix: Web remote-control status changes happen on the main / relay side;
        // if the dialog synced only once on open, the status would sit at "waiting for connection"
        // indefinitely. A lightweight poll fills the gap; single failures are silently ignored so
        // user interaction is not interrupted.
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

  // Remote-control diagnostics: the panel's "Pull mobile logs" is the only user entry (the help-menu
  // item was removed on 2026-10-28); the main process reports the result in a dialog.
  const handlePullMobileLogs = () => {
    logger.info("[WebRemoteControlDialog] 拉取手机日志", {
      sessionId: status.sessionId ?? "none",
    });
    void platform.executeDesktopCommand(DesktopCommandIds.PullMobileLogs);
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
          // than Remote Connect, looking inconsistently layered when the QR code or Bot Channel
          // content showed. Reuse Remote Connect's outer dimensions but do not force full height;
          // remote-control content is sparser, and self-sizing avoids an empty-looking window.
          className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix: this dialog sits near the top of the desktop window, where the default close
            // button easily misses clicks inside the Electron drag region. Switch to an explicit
            // click-to-close button and mark it no-drag so the top-right close action lands reliably.
            // Bugfix: clickable controls in the remote-control dialog previously had no explicit
            // pointer cursor and did not look actionable on desktop hover. Add the pointer cursor
            // for enabled state only; disabled state keeps Button's disabled interaction semantics.
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
                {status.status === "auth-required" ? (
                  <div
                    data-testid="web-remote-control-auth-required"
                    className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-6 text-center"
                  >
                    <MonitorSmartphone className="size-8 text-foreground-subtle" />
                    <div className="space-y-2">
                      <h3 className="text-ui-base font-medium text-foreground">
                        {intl.formatMessage({ id: "webRemoteControl.authRequired.title" })}
                      </h3>
                      <p className="text-ui-base/relaxed text-foreground-subtle">
                        {intl.formatMessage({ id: "webRemoteControl.authRequired.description" })}
                      </p>
                    </div>
                    <WebRemoteControlLoginButton onOpenChange={onOpenChange} />
                  </div>
                ) : (
                  <>
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
                        {status.mobileConnected ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="default"
                            data-testid="web-remote-control-pull-mobile-logs"
                            className="shrink-0 gap-2 enabled:cursor-pointer"
                            onClick={handlePullMobileLogs}
                          >
                            <FileDown className="size-3.5" />
                            {intl.formatMessage({ id: "webRemoteControl.pullMobileLogs" })}
                          </Button>
                        ) : null}
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
                          {status.failure?.message &&
                          status.failure.message !== failureDescription ? (
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
                  </>
                )}
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
                        {/* Bugfix: the remote-control Bot Channel entries used generic lucide icons, and users could not tell WeChat, Feishu, and Telegram apart at a glance.
                            Reuse the BotsDialog channel logos directly without an extra wrapper so the brand icon itself carries the visual identity. */}
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
        entryProvider={botEntryProvider}
      />
    </>
  );
});
