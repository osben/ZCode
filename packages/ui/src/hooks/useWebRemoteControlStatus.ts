import { useEffect, useState } from "react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileViewState?.activeWorkspaceKey === right.mobileViewState?.activeWorkspaceKey &&
    left.mobileViewState?.activeTaskId === right.mobileViewState?.activeTaskId &&
    left.mobileViewState?.updatedAt === right.mobileViewState?.updatedAt &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

export function useWebRemoteControlStatus({
  enabled = true,
  intervalMs = 1000,
}: {
  enabled?: boolean;
  intervalMs?: number;
} = {}): WebRemoteControlStatus {
  const platform = useOptionalPlatform();
  const [status, setStatus] = useState<WebRemoteControlStatus>({
    status: "idle",
  });

  useEffect(() => {
    if (!enabled || !platform) {
      setStatus({ status: "idle" });
      return;
    }

    let disposed = false;

    const applyStatus = (nextStatus: WebRemoteControlStatus) => {
      if (disposed) {
        return;
      }
      setStatus((currentStatus) =>
        isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
      );
    };

    const syncStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        applyStatus(nextStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Bugfix: remote-control connection status comes from main/relay; the desktop UI must
        // poll to notice tasks opened from the phone. Polling failure is high-frequency
        // diagnostic info and goes only to debug, keeping production logs from growing with the
        // refresh rate.
        logger.debug("[useWebRemoteControlStatus] 同步 Web 远程控制状态失败", {
          error: message,
        });
      }
    };

    void syncStatus();
    const disposeStatusChanged = platform.onWebRemoteControlStatusChanged?.((nextStatus) => {
      // Bugfix: if only the 1s poll is awaited after start/refresh, main may not yet have the
      // renderer-synced task snapshot when the phone scans right away. main is already the
      // source of truth for remote-control session/transport state, so event pushes are
      // consumed first here and polling remains only as a legacy-platform fallback.
      applyStatus(nextStatus);
    });
    const intervalId = window.setInterval(() => {
      void syncStatus();
    }, intervalMs);

    return () => {
      disposed = true;
      disposeStatusChanged?.();
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, platform]);

  return status;
}
