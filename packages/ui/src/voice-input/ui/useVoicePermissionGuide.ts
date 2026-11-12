/**
 * 麦克风权限引导状态（docs/chat/composer-voice-input.md「麦克风权限」）。
 *
 * - phase 只由 show（权限被拒绝）、close、reauthorize 的结果改变；UI 只读。
 * - 窗口重新获得焦点时（用户从系统设置切回）静默复查权限，已授权则关闭引导并提示成功。
 * - reauthorize 在途时忽略重复点击；Main 侧也会合并并发重置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { VoicePermissionGuide, VoicePermissionPhase } from "@/voice-input/contract.js";
import { resolveVoiceInputOs } from "@/voice-input/domain/voiceInputFailure.js";

export function useVoicePermissionGuide(): VoicePermissionGuide {
  const platform = useOptionalPlatform();
  const microphone = platform?.microphone;
  const { intl } = useZCodeIntl();
  const os = resolveVoiceInputOs(typeof navigator === "undefined" ? "" : navigator.userAgent);

  const [phase, setPhase] = useState<VoicePermissionPhase | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const close = useCallback(() => setPhase(null), []);
  const show = useCallback(() => setPhase("denied"), []);

  const announceGranted = useCallback(() => {
    setPhase(null);
    toast(intl.formatMessage({ id: "voiceInput.permission.granted" }), {
      variant: "success",
      dedupeKey: "voice-input-permission-granted",
    });
  }, [intl]);

  const openSettings = useCallback(() => {
    void microphone?.openSettings("privacy");
  }, [microphone]);

  const reauthorize = useCallback(async () => {
    if (!microphone || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const result = await microphone.resetAccess().catch(() => "failed" as const);
    busyRef.current = false;
    setBusy(false);
    logger.lifecycle.info("[voice-input] reauthorize", { result });
    switch (result) {
      case "granted":
        announceGranted();
        return;
      case "restart-required":
        // 仅在引导仍可见时切换阶段，避免用户已关闭弹层后又被重新打开。
        setPhase((current) => (current ? "restart-required" : null));
        return;
      case "failed":
        // 无法在应用内重置（受限、非打包版或 tccutil 失败）：引导用户到系统设置手动开启。
        microphone.openSettings("privacy");
        return;
      case "denied":
        return;
    }
  }, [announceGranted, microphone]);

  const relaunch = useCallback(() => {
    if (typeof platform?.executeDesktopCommand !== "function") return;
    logger.lifecycle.info("[voice-input] relaunch for microphone permission");
    void platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp).catch((error: unknown) => {
      logger.lifecycle.warn("[voice-input] relaunch failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [platform]);

  const visible = phase !== null;
  useEffect(() => {
    if (!visible || !microphone) return;
    const recheckOnFocus = () => {
      if (busyRef.current) return;
      microphone
        .ensureAccess()
        .catch(() => "unsupported" as const)
        .then((access) => {
          if (access === "granted" && !busyRef.current) announceGranted();
        });
    };
    window.addEventListener("focus", recheckOnFocus);
    return () => window.removeEventListener("focus", recheckOnFocus);
  }, [announceGranted, microphone, visible]);

  return useMemo(
    () => ({
      phase,
      os: os === "windows" ? "windows" : "mac",
      available: os !== "linux",
      busy,
      show,
      close,
      openSettings,
      reauthorize,
      relaunch,
    }),
    [busy, close, openSettings, os, phase, reauthorize, relaunch, show],
  );
}
