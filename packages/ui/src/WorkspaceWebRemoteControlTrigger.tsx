import { useState } from "react";
import { Smartphone } from "lucide-react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import {
  buildWebRemoteControlEntryViewTelemetry,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

export function getWebRemoteControlTriggerPresentation(
  status: Pick<WebRemoteControlStatus, "status" | "mobileConnected">,
  formatMessage: FormatMessage,
): { iconClassName: string; tooltip: string } {
  if (status.status === "error") {
    return {
      iconClassName: "text-destructive",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.error" }),
    };
  }

  if (status.status === "active") {
    // Bugfix: while the relay reconnects, main may first lower status to starting/running while
    // mobileConnected still retains the previous pairing state. Show “connected” only for active
    // status so the button does not disagree with the actual connection state shown in the dialog.
    return {
      iconClassName: "text-success",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connected",
      }),
    };
  }

  if (status.status === "starting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.starting",
      }),
    };
  }

  if (status.status === "connecting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connecting",
      }),
    };
  }

  if (status.status === "running") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.waiting" }),
    };
  }

  return {
    iconClassName: "text-foreground-subtle",
    tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
  };
}

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const enabled = useWebRemoteControlFeatureEnabled();

  // Bugfix: when hidden by default in production, running the remote-session resolution hook still
  // requires TabStoreProvider and causes static rendering to throw early. Read the feature provider
  // that has no store dependency first, then decide whether to render the actual entry content.
  if (!enabled) {
    return null;
  }

  return (
    <WorkspaceWebRemoteControlTriggerContent
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      initialTaskId={initialTaskId}
      compact={compact}
      className={className}
    />
  );
}

function WorkspaceWebRemoteControlTriggerContent({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const mappedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // Root cause: remoteSessionId on the tab may become stale during reconnect. Remote control uses
  // both identity and session; passing through an old, unregistered value can form the wrong
  // endpoint. Use only the live session validated by the resolver for this identity; if it has not
  // recovered, keep the dialog in remote-waiting.
  const currentRemoteSessionId = mappedRemoteSessionId ?? undefined;
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  const remoteControlStatus = useWebRemoteControlStatus();
  const triggerPresentation = getWebRemoteControlTriggerPresentation(
    remoteControlStatus,
    intl.formatMessage,
  );

  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        description={triggerPresentation.tooltip}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            if (platform) {
              void reportAppTelemetryEvent(
                platform,
                buildWebRemoteControlEntryViewTelemetry({
                  workspaceKind:
                    workspaceIdentity?.trim() || currentRemoteSessionId ? "remote" : "local",
                  remoteKind: workspaceIdentity
                    ? parseRemoteWorkspaceIdentity(workspaceIdentity)?.kind
                    : undefined,
                }),
                "web-remote-control-entry",
              );
            }
            logger.info("[WorkspaceWebRemoteControlTrigger] 打开 Web 远程控制弹层", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
              remoteSessionId: currentRemoteSessionId ?? "none",
              initialTaskId: initialTaskId ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          {/* Bugfix: The entry used to show only a static phone icon, so desktop users could not tell whether a phone was connected.
              这里复用远控状态轮询结果，用语义色表达连接状态，并把入口名称和状态文案合进同一个 tooltip，
              避免桌面端 footer 外层和按钮内层同时弹出两份提示。 */}
          <Smartphone className={cn("size-4", triggerPresentation.iconClassName)} />
          {compact ? (
            <span className="sr-only">
              {intl.formatMessage({ id: "webRemoteControl.trigger" })}
            </span>
          ) : (
            intl.formatMessage({ id: "webRemoteControl.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={currentRemoteSessionId}
        initialTaskId={initialTaskId}
      />
    </>
  );
}
