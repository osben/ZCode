/* eslint-disable max-lines -- Permission-channel registration, drag panel, and foreground-app return wait share main-process session state. */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { PlatformChannels, type CuaPermissionKind, type Locale } from "@zcode/shared";
import {
  cuaHelperBundleFingerprintUnchanged,
  openCuaPermissionOnboarding,
  prepareCuaHelperPermissionDrag,
} from "./cuaAccessibilitySettings.js";
import {
  createCuaPermissionDragPanel,
  createRealCuaPermissionPanelWindow,
  type CuaPermissionDragPanel,
} from "./cuaPermissionDragPanel.js";
import { createSystemSettingsWindowWatcher } from "./cuaSystemSettingsWindowWatcher.js";

const execFileAsync = promisify(execFile);
const MACOS_SYSTEM_SETTINGS_BUNDLE_ID = "com.apple.systempreferences";
// 1x1 transparent PNG. startDrag requires a non-empty icon on macOS (electron.d.ts: "The image must be non-empty
// on macOS"). Use this if even the bundled ZCode icon cannot be read; otherwise startDrag throws and the user cannot drag anything.
const CUA_HELPER_DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
/** Use 64pt for both the drag cursor and panel tile to avoid an oversized cursor image. */
const CUA_DRAG_ICON_SIZE = 64;

/**
 * ZCode icon shared by the drag cursor and panel tile (module-cached to avoid reading from disk on every drag).
 *
 * Do not use `nativeImage.createFromNamedImage("NSApplicationIcon")`: it returns the **current host app** icon, which is
 * Electron.app in development, so dragging would show Electron's default icon.
 * Read the bundled ZCode icon explicitly instead (electron-builder puts build/icon.png at resources/icon.png).
 */
let cachedZCodeIcon: Electron.NativeImage | null = null;

function resolveZCodeIcon(): Electron.NativeImage {
  if (cachedZCodeIcon && !cachedZCodeIcon.isEmpty()) return cachedZCodeIcon;
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "..", "..", "build", "icon.png");
  const image = nativeImage.createFromPath(iconPath);
  cachedZCodeIcon = image.isEmpty()
    ? nativeImage.createFromDataURL(CUA_HELPER_DRAG_ICON_DATA_URL)
    : image;
  return cachedZCodeIcon;
}

interface CuaApplicationReturnOptions {
  openSettings: () => Promise<void>;
  timeoutMs: number;
  signal: AbortSignal;
  resolveFrontmostBundleId?: () => Promise<string | null>;
}

async function resolveFrontmostBundleId(): Promise<string | null> {
  const { stdout: front } = await execFileAsync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const asn = front.trim();
  if (!asn) return null;
  const { stdout: info } = await execFileAsync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleid", asn],
    { encoding: "utf8", timeout: 2_000 },
  );
  return info.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? null;
}

/**
 * Listen to Electron main's app-level window signals rather than the origin renderer's DOM focus. If the user starts from
 * window A and returns to window B, the original IPC from A must still advance. Install listeners before openExternal to close race windows.
 */
function waitForCuaApplicationReturn({
  openSettings,
  timeoutMs,
  signal,
  resolveFrontmostBundleId: readFrontmostBundleId = resolveFrontmostBundleId,
}: CuaApplicationReturnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let settingsOpened = false;
    // LaunchServices lookup takes two subprocess round trips and may read Settings' ASN but return its bundle ID only
    // after the ZCode focus edge. Pair probe-start/during-probe blur with later focus using monotonic sequence numbers,
    // preserving real returns without reviving a stale BrowserWindow.isFocused() snapshot.
    let applicationEventSequence = 0;
    let latestBlurSequence = 0;
    let latestZCodeReturnSequence = 0;
    let observedSystemSettingsAfterSequence: number | null = null;
    let activeInspections = 0;
    let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (observationTimer) clearTimeout(observationTimer);
      if (inspectionTimer) clearTimeout(inspectionTimer);
      app.removeListener("browser-window-blur", onBlur);
      app.removeListener("browser-window-focus", onFocus);
      app.removeListener("activate", onFocus);
      app.removeListener("before-quit", onQuit);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const maybeFinishReturn = () => {
      if (
        settingsOpened &&
        observedSystemSettingsAfterSequence !== null &&
        latestZCodeReturnSequence > observedSystemSettingsAfterSequence
      )
        finish();
    };
    const scheduleInspection = () => {
      if (settled || activeInspections > 0 || observedSystemSettingsAfterSequence !== null) return;
      if (inspectionTimer) clearTimeout(inspectionTimer);
      inspectionTimer = setTimeout(inspectFrontmost, 150);
    };
    const inspectFrontmost = (forceAtEventBoundary = false) => {
      if (
        settled ||
        observedSystemSettingsAfterSequence !== null ||
        (!forceAtEventBoundary && activeInspections > 0)
      )
        return;
      if (inspectionTimer) {
        clearTimeout(inspectionTimer);
        inspectionTimer = undefined;
      }
      const inspectionStartedAtSequence = applicationEventSequence;
      // Only a probe started during an away interval (the latest app event is blur and no return focus has occurred) can
      // establish evidence for this System Settings round-trip. A query triggered by return focus cannot pair with that
      // same focus or clear the timeout, even if it later reads a stale Settings value from LaunchServices.
      const inspectionStartedWhileAway = latestBlurSequence > latestZCodeReturnSequence;
      activeInspections += 1;
      void readFrontmostBundleId().then(
        (bundleId) => {
          activeInspections -= 1;
          if (settled) return;
          if (
            bundleId === MACOS_SYSTEM_SETTINGS_BUNDLE_ID &&
            inspectionStartedWhileAway &&
            inspectionStartedAtSequence >= latestBlurSequence
          ) {
            // If another blur arrives during this query, it must also precede an acceptable ZCode return edge. This
            // excludes a stale focus from switching windows inside ZCode before opening Settings.
            // LaunchServices may return before Electron delivers blur. If a pre-open probe reads Settings after a ZCode
            // focus/activate that occurred before the probe started, immediately treating that old focus as a return is wrong.
            // The probe must start after the latest blur and before return focus. Checking only whether blur ever occurred
            // could reuse an earlier internal window-switch blur; a probe started after focus could read a stale LaunchServices
            // value and clear the timeout forever. Ignore both cases and let blur-bound/away-interval probes confirm.
            observedSystemSettingsAfterSequence = Math.max(
              inspectionStartedAtSequence,
              latestBlurSequence,
            );
            // The old timer treated the machine SLA for opening System Settings as a user-action deadline. Clear it as
            // soon as Settings is confirmed in the foreground; however long the user stays there, do not lose return/restart
            // and end only on an explicit lifecycle signal.
            if (observationTimer) {
              clearTimeout(observationTimer);
              observationTimer = undefined;
            }
            maybeFinishReturn();
            return;
          }
          scheduleInspection();
        },
        () => {
          activeInspections -= 1;
          scheduleInspection();
        },
      );
    };
    const onBlur = () => {
      latestBlurSequence = ++applicationEventSequence;
      // The pre-open lsappinfo query may have sampled ZCode but be stuck on the second info subprocess.
      // Reusing the global single-flight would miss a complete round-trip where Settings opens and quickly returns.
      // A blur edge must force a parallel time-bound probe; ordinary 150ms polling remains single-flight to avoid unbounded concurrency.
      inspectFrontmost(true);
    };
    const onFocus = () => {
      // After System Settings becomes foreground, BrowserWindow.isFocused() may briefly retain the old true value.
      // Reading that stale snapshot when a foreground probe completes would mistake "Settings just opened" for "user returned".
      // Record sequence numbers for focus/activate first. If the corresponding Settings probe is still running, its delayed
      // result can use the inspection-start snapshot to prove this was a later edge. The edge may also precede openExternal resolving.
      latestZCodeReturnSequence = ++applicationEventSequence;
      inspectFrontmost();
      maybeFinishReturn();
    };
    const onQuit = () => finish(new Error("ZCode quit during CUA permission onboarding"));
    const onAbort = () =>
      finish(signal.reason ?? new Error("CUA permission onboarding origin window closed"));
    observationTimer = setTimeout(
      () =>
        finish(
          new Error(`System Settings did not return to ZCode within ${Math.max(1, timeoutMs)}ms`),
        ),
      Math.max(1, timeoutMs),
    );

    app.on("browser-window-blur", onBlur);
    app.on("browser-window-focus", onFocus);
    app.on("activate", onFocus);
    app.on("before-quit", onQuit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // All listeners are installed before calling openExternal; poll LaunchServices for the actual foreground app from here.
    // Only after observing System Settings can a later ZCode focus advance; internal window switches are not mistaken for a return.
    inspectFrontmost();
    void openSettings().then(
      () => {
        settingsOpened = true;
        maybeFinishReturn();
      },
      (error) => finish(error),
    );
  });
}

function normalizePermissionList(value: unknown): CuaPermissionKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const set = new Set<CuaPermissionKind>();
  for (const permission of value) {
    if (permission === "accessibility" || permission === "screen_recording") {
      set.add(permission);
    }
  }
  return [...set];
}

function normalizeOnboardingOperationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null;
}

/**
 * Create a floating panel for one onboarding session, including its snap-position data source.
 *
 * If the watcher cannot get bounds (binary not bundled, build without swiftc, Settings page not open, or process crash),
 * `getSettingsBounds` returns null and the positioner fails open by centering the panel at the bottom of the screen.
 * Snapping is a visual enhancement and must never be required for permission onboarding to work.
 */
function createDragPanelForSession(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  getLocale: () => Locale,
): CuaPermissionDragPanel {
  const watcher = createSystemSettingsWindowWatcher({
    binaryPath: resolveWindowBoundsBinaryPath(),
    logger,
  });
  watcher.start();

  return createCuaPermissionDragPanel({
    createWindow: createRealCuaPermissionPanelWindow({
      BrowserWindow,
      app,
      preloadPath: join(import.meta.dirname, "../preload/cuaPermissionPanel.cjs"),
      rendererDir: join(import.meta.dirname, "../renderer"),
      rendererDevUrl: process.env["ELECTRON_RENDERER_URL"],
    }),
    getDisplayWorkArea: () => screen.getPrimaryDisplay().workArea,
    getSettingsBounds: () => watcher.latest(),
    stopSettingsBounds: () => watcher.stop(),
    getLocale,
    // Use the real ZCode icon for the tile so it matches the icon in the System Settings permission list and users can
    // identify the item they are dragging with the entry that should appear in the list.
    getIconDataUrl: () =>
      resolveZCodeIcon()
        .resize({ width: CUA_DRAG_ICON_SIZE, height: CUA_DRAG_ICON_SIZE })
        .toDataURL(),
    logger,
  });
}

/** Production uses extraResources from the signed bundle; development uses build output from the checkout. */
function resolveWindowBoundsBinaryPath(): string {
  const relative = join("macos-window-bounds", "zcode-window-bounds");
  return app.isPackaged
    ? join(process.resourcesPath, relative)
    : join(import.meta.dirname, "..", "..", "resources", relative);
}

export function registerCuaPermissionIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  currentApplicationLocale: () => Locale;
}) {
  // operationId is scoped to one webContents ID namespace so another renderer cannot guess an ID and cancel someone else's
  // participant. Always delete it when invoke settles; the existing signal path handles destroyed as a fallback.
  const onboardingControllers = new Map<string, AbortController>();
  const operationKey = (senderId: number, operationId: string) => `${senderId}\0${operationId}`;

  // Cache the verified Helper.app path and byte fingerprint. Native file dragging requires a *synchronous* call to
  // event.sender.startDrag() in the dragstart event chain; it cannot wait for async install/verify I/O without missing the
  // OS drag gesture window. Prepare when the panel mounts, then dragstart reads the cache and compares the fingerprint synchronously.
  let verifiedHelperAppPath: string | null = null;
  let verifiedHelperFingerprint: string | null = null;
  // Helper bundle display name. Show it on the panel tile instead of a hard-coded string; macOS uses this value in the
  // permission list (with a Dev suffix in development), so users can verify that the item they dragged is the same one.
  let verifiedHelperDisplayName: string | null = null;
  // Floating panel for the current session. Notify it to freeze its position after a drop. StartDrag and onboarding are
  // separate handlers, so share this reference at this level; reset it to null when the session ends.
  let activeDragPanel: CuaPermissionDragPanel | null = null;

  function cacheVerifiedHelper(
    helperAppPath: string,
    verifiedFingerprint: string,
    displayName: string | null,
  ): void {
    verifiedHelperAppPath = helperAppPath;
    verifiedHelperFingerprint = verifiedFingerprint;
    verifiedHelperDisplayName = displayName;
  }

  function clearVerifiedHelper(): void {
    verifiedHelperAppPath = null;
    verifiedHelperFingerprint = null;
    verifiedHelperDisplayName = null;
  }

  async function refreshVerifiedHelperAppPath(): Promise<void> {
    const result = await prepareCuaHelperPermissionDrag({ logger: options.logger });
    if (result.success && result.helperAppPath && result.helperBundleFingerprint) {
      cacheVerifiedHelper(
        result.helperAppPath,
        result.helperBundleFingerprint,
        result.helperDisplayName ?? null,
      );
    } else {
      clearVerifiedHelper();
      options.logger.warn("[cua-permission-onboarding] prepare helper drag failed", result.error);
    }
  }

  // Called when the panel mounts: asynchronously install+verify and cache the verified path/fingerprint for synchronous dragging.
  ipcMain.handle(PlatformChannels.PrepareCuaHelperPermissionDrag, async () => {
    await refreshVerifiedHelperAppPath();
    // The fingerprint is synchronous TOCTOU evidence for main and must never be returned to the renderer over IPC.
    return {
      success: verifiedHelperAppPath !== null,
      ...(verifiedHelperAppPath !== null ? { helperAppPath: verifiedHelperAppPath } : {}),
      ...(verifiedHelperDisplayName !== null
        ? { helperDisplayName: verifiedHelperDisplayName }
        : {}),
      ...(verifiedHelperAppPath === null ? { error: "helper drag preparation failed" } : {}),
    };
  });

  ipcMain.on(PlatformChannels.StartCuaHelperPermissionDrag, (event) => {
    const helperAppPath = verifiedHelperAppPath;
    const fingerprint = verifiedHelperFingerprint;
    if (!helperAppPath || !fingerprint) {
      // Not prewarmed: never run async install/verify here because it would miss the drag gesture. Prepare in the background
      // for the next drag and skip this one (panel mount already triggered prepare, so this is not expected normally).
      options.logger.warn(
        "[cua-permission-onboarding] helper drag not prepared yet; verifying in background for next drag",
      );
      void refreshVerifiedHelperAppPath();
      return;
    }
    // TOCTOU guard: after prepare (verification), a same-UID attacker could overwrite Helper.app before this point, while
    // TCC grants permission to the identity of the dropped bundle. Compare the byte fingerprint synchronously
    // (ino/ctime/size; user space cannot roll back ctime). On mismatch, reject the drag and clear/rebuild the cache; never
    // drag a possibly replaced bundle into Accessibility/Screen Recording. This takes microseconds and will not miss the gesture.
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, fingerprint)) {
      options.logger.warn(
        "[cua-permission-onboarding] cached helper changed since verification; refusing to drag a possibly-tampered bundle",
      );
      clearVerifiedHelper();
      void refreshVerifiedHelperAppPath();
      return;
    }
    const icon = resolveZCodeIcon().resize({
      width: CUA_DRAG_ICON_SIZE,
      height: CUA_DRAG_ICON_SIZE,
    });
    try {
      // Start native file dragging synchronously; this is the only way for the OS to actually drag Helper.app into System Settings.
      event.sender.startDrag({ file: helperAppPath, icon });
    } catch (error) {
      options.logger.warn(
        "[cua-permission-onboarding] helper drag failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    // The drop completed and System Settings may show a modal prompt. Continuing to track its window would make the panel
    // chase the prompt and become obscured beneath it.
    activeDragPanel?.freezePosition();
    // A later dragend/mouseup hides the panel (see handler below); freeze is the fallback if that signal never arrives,
    // at least preventing the panel from chasing the system prompt.
    // Refresh the cache in the background (Helper may have been reinstalled/upgraded) so the next drag uses the latest verified path/fingerprint.
    void refreshVerifiedHelperAppPath();
  });

  // Drag gesture ended; permission was applied, so let Settings and its restart prompt take over. Hide rather than destroy:
  // the next permission stage reuses the same window. hide is idempotent, so duplicate dragend/mouseup notifications are harmless.
  ipcMain.on(PlatformChannels.NotifyCuaHelperPermissionDragEnded, () => {
    activeDragPanel?.hide();
  });

  ipcMain.on(PlatformChannels.CancelCuaPermissionOnboarding, (event, payload) => {
    const senderId = event.sender?.id;
    const operationId = normalizeOnboardingOperationId(
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).operationId
        : undefined,
    );
    if (!Number.isInteger(senderId) || !operationId) return;
    onboardingControllers
      .get(operationKey(senderId, operationId))
      ?.abort(new Error("CUA permission onboarding surface closed"));
  });

  ipcMain.handle(PlatformChannels.OpenCuaPermissionOnboarding, async (event, payload) => {
    // Open the corresponding System Settings pane directly (no confirmation dialog and no Finder Helper icon/animation).
    const payloadRecord =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
    const operationId = normalizeOnboardingOperationId(payloadRecord?.operationId);
    const requiredPermissions = normalizePermissionList(payloadRecord?.requiredPermissions);
    const originController = new AbortController();
    const sender = event.sender as {
      id?: number;
      isDestroyed?: () => boolean;
      once?: (event: "destroyed", listener: () => void) => void;
      removeListener?: (event: "destroyed", listener: () => void) => void;
    };
    const senderId =
      typeof sender.id === "number" && Number.isInteger(sender.id) ? sender.id : null;
    const participantOperationKey =
      senderId !== null && operationId ? operationKey(senderId, operationId) : null;
    if (participantOperationKey && onboardingControllers.has(participantOperationKey)) {
      return {
        success: false,
        canceled: true,
        error: "duplicate CUA permission onboarding operation id",
      };
    }
    if (participantOperationKey) {
      onboardingControllers.set(participantOperationKey, originController);
    }
    const abortForDestroyedOrigin = () =>
      originController.abort(new Error("CUA permission onboarding origin window closed"));
    if (sender.isDestroyed?.()) abortForDestroyedOrigin();
    else sender.once?.("destroyed", abortForDestroyedOrigin);

    // Create lazily: the panel is useful only in actual macOS onboarding, and must be created/destroyed per session (not a
    // singleton, which could reuse a window left by the previous session). Keep null on non-darwin; call sites use ?. short-circuiting.
    //
    // Use try/catch: creating the panel resolves a binary path, starts a watcher subprocess, and creates a BrowserWindow.
    // None of those failures should break all permission onboarding and prevent Settings from opening. Without the panel,
    // Settings remains usable and the user can drag the .app from Finder into the list. Degrade gracefully instead of failing completely.
    let dragPanel: CuaPermissionDragPanel | null = null;
    if (process.platform === "darwin") {
      try {
        dragPanel = createDragPanelForSession(options.logger, options.currentApplicationLocale);
      } catch (error) {
        options.logger.warn(
          "[cua-permission-onboarding] drag panel unavailable; continuing with settings pane only",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    activeDragPanel = dragPanel;

    let result: Awaited<ReturnType<typeof openCuaPermissionOnboarding>>;
    try {
      result = await openCuaPermissionOnboarding({
        initialPermission:
          payloadRecord?.initialPermission === "screen_recording"
            ? "screen_recording"
            : "accessibility",
        ...(requiredPermissions !== undefined ? { requiredPermissions } : {}),
        ...(typeof sender.id === "number" && Number.isInteger(sender.id)
          ? { participantKey: `webContents:${sender.id}` }
          : {}),
        signal: originController.signal,
        // For each stage, show the drag panel while opening Settings (the only way to add Helper to the TCC list), then hide
        // it when that stage's wait ends. The finally block below cleans up terminal session state.
        openSettingsAndWaitForReturn: async (stage) => {
          try {
            await waitForCuaApplicationReturn({
              ...stage,
              openSettings: async () => {
                await stage.openSettings();
                dragPanel?.show(stage.permission);
              },
            });
          } finally {
            dragPanel?.hide();
          }
        },
        logger: options.logger,
      });
    } finally {
      // Destroy the panel for every terminal session state (success/cancel/timeout/origin destroyed). A PiP panel once
      // remained open because unconditional cleanup was missing; keep this in finally so it does not depend on a success path.
      dragPanel?.destroy();
      if (activeDragPanel === dragPanel) activeDragPanel = null;
      sender.removeListener?.("destroyed", abortForDestroyedOrigin);
      if (
        participantOperationKey &&
        onboardingControllers.get(participantOperationKey) === originController
      ) {
        onboardingControllers.delete(participantOperationKey);
      }
    }
    // The user may remain in System Settings for a long time during onboarding, so do not reuse stale verification evidence
    // from stage start as a "verified fingerprint" after returning. On success, prepare again with a fresh verify+fingerprint for the next drag.
    if (result.success) void refreshVerifiedHelperAppPath();
    return result;
  });

  // A 2026-08 audit removed Prepare/StartCuaHelperPermissionDrag as dead code (the renderer had no caller then, and
  // onboarding used a native prompt to add Helper to the TCC list automatically). After that prompt was removed, dragging
  // became the only way to add Helper to the permission list, so both channels were restored above.
}
