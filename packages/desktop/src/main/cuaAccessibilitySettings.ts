/* eslint-disable max-lines -- Installer verification, main-process permission sessions, and drag TOCTOU checks share one Helper identity. */
// Permission onboarding does not trigger native macOS permission prompts. If every TCC stage launched the Helper through
// LaunchServices in one-shot permission mode and called AXIsProcessTrustedWithOptions{prompt:true} / CGRequestScreenCaptureAccess
// inside the Helper to make it "appear automatically" in the permission list, the user would get an interrupting system dialog.
// Instead, open the relevant Settings page and let the user drag the .app from the floating panel into the list
// (observed auth_value becomes 2 immediately after the drop; a prompt only creates the entry, which the user must still find and enable).
// Keep each stage's verification fingerprint on the session and consume it with a synchronous comparison before dragstart.
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";
import type { CuaHelperInstallerOptions } from "@zcode/services/node";
import {
  resolveHelperPermissionSubjectIdentity,
  type HelperPermissionSubjectIdentity,
} from "@zcode/services/cua-permission-broker";
import type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { createDesktopCuaHelperInstaller } from "./desktopCuaHelperInstaller.js";

const MACOS_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MACOS_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

interface OpenCuaAccessibilitySettingsOptions {
  initialPermission?: CuaPermissionKind;
  requiredPermissions?: CuaPermissionKind[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** Renderer/webContents identity injected by main IPC; repeated joins from the same host grant recovery only once. */
  participantKey?: string;
  sessionTimeoutMs?: number;
  settingsReturnTimeoutMs?: number;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  ensureHelperInstalled?: () => Promise<string>;
  /** Explicitly injected by tests or the host; production resolves the bundled Helper from Electron Resources by default. */
  bundledHelperAppPath?: string;
  /** Run full installation verification before each TCC stage; production uses installer.verifyInstalled by default. */
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
  openSettingsUrl?: (url: string) => Promise<void>;
  /**
   * Register the return signal before calling openSettings to avoid missing a transition away from or back to System Settings.
   * The production IPC adapter listens to Electron app/browser-window; unit tests can call openSettings and return immediately.
   */
  openSettingsAndWaitForReturn?: (options: {
    permission: CuaPermissionKind;
    sessionId: string;
    timeoutMs: number;
    signal: AbortSignal;
    openSettings: () => Promise<void>;
  }) => Promise<void>;
}

// This timeout limits only the machine phase that waits for System Settings to appear. Once Settings is confirmed in the
// foreground, the user's permission choice has no wall-clock deadline and ends only on surface cancel, origin destroyed, or app quit.
const DEFAULT_SETTINGS_RETURN_TIMEOUT_MS = 2 * 60_000;
// The old drag onboarding placed Screen Recording first, opposite to the order shown in the permission list.
// When both are missing, handle Accessibility first, then Screen Recording.
const PERMISSION_STAGE_ORDER: readonly CuaPermissionKind[] = ["accessibility", "screen_recording"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Drag TOCTOU guard: a same-UID attacker could overwrite the .app verified during prepare before the user drops it into
// System Settings, while TCC binds permission to the dropped bundle identity. At drag time, require synchronous proof
// that the bytes have not changed since verification; running codesign on a 120MB bundle is too slow and misses dragstart.
// Use a lightweight fingerprint of critical files' ino/ctime/size (ctime is inode change time and cannot be rolled back by
// user space); replacing Mach-O, signature manifests, or Info.plist changes the fingerprint. Capture it during prepare
// and compare synchronously before dragstart. On mismatch, reject the drop, clear the cache, and prepare again. The only
// remaining window is the microseconds between comparison and startDrag, comparable to verifyInstalled→launch.
type CuaHelperBundleFingerprint = string;

function statSignature(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.ctimeNs}:${st.size}`;
  } catch {
    return "MISSING";
  }
}

function bundleTreeFingerprint(root: string, maxEntries = 512): string {
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: root, relativePath: "." },
  ];
  const parts: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (parts.length >= maxEntries) return `${parts.join(",")},TOO_MANY`;
    parts.push(`${current.relativePath}:${statSignature(current.absolutePath)}`);
    let children: string[];
    try {
      children = readdirSync(current.absolutePath).sort();
    } catch {
      continue;
    }
    for (const child of children) {
      pending.push({
        absolutePath: join(current.absolutePath, child),
        relativePath: `${current.relativePath}/${child}`,
      });
    }
  }
  return parts.join(",");
}

function captureCuaHelperBundleFingerprint(appPath: string): CuaHelperBundleFingerprint {
  const parts = [
    `app=${statSignature(appPath)}`,
    `sig=${statSignature(join(appPath, "Contents", "_CodeSignature", "CodeResources"))}`,
    `info=${statSignature(join(appPath, "Contents", "Info.plist"))}`,
    // ax_macos.node and runtime dylibs shipped with SEA are under Resources. Checking only CodeResources stat cannot
    // detect in-place resource replacement; recursively fingerprint inode/ctime/size to reject this TOCTOU synchronously at dragstart.
    `resources=${bundleTreeFingerprint(join(appPath, "Contents", "Resources"))}`,
  ];
  try {
    const macosDir = join(appPath, "Contents", "MacOS");
    const entries = readdirSync(macosDir).sort();
    parts.push(
      `macos=${entries.map((entry) => `${entry}:${statSignature(join(macosDir, entry))}`).join(",")}`,
    );
  } catch {
    parts.push("macos=MISSING");
  }
  return parts.join("|");
}

export function cuaHelperBundleFingerprintUnchanged(
  appPath: string,
  fingerprint: CuaHelperBundleFingerprint,
): boolean {
  return captureCuaHelperBundleFingerprint(appPath) === fingerprint;
}

function normalizePermission(value: unknown): CuaPermissionKind {
  return value === "screen_recording" ? "screen_recording" : "accessibility";
}

function normalizeRequiredPermissions(
  options: OpenCuaAccessibilitySettingsOptions,
): CuaPermissionKind[] {
  const requested = Array.isArray(options.requiredPermissions)
    ? options.requiredPermissions
    : [normalizePermission(options.initialPermission)];
  const requestedSet = new Set(
    requested.filter(
      (permission): permission is CuaPermissionKind =>
        permission === "screen_recording" || permission === "accessibility",
    ),
  );
  return PERMISSION_STAGE_ORDER.filter((permission) => requestedSet.has(permission));
}

function settingsUrlForPermission(permission: CuaPermissionKind): string {
  return permission === "screen_recording"
    ? MACOS_SCREEN_RECORDING_SETTINGS_URL
    : MACOS_ACCESSIBILITY_SETTINGS_URL;
}

function sameHelperPermissionIdentity(
  expected: HelperPermissionSubjectIdentity,
  actual: HelperPermissionSubjectIdentity,
): boolean {
  return (
    expected.appPath === actual.appPath &&
    expected.executablePath === actual.executablePath &&
    expected.displayName === actual.displayName &&
    expected.bundleId === actual.bundleId
  );
}

async function verifyHelperPermissionIdentityUnchanged(
  identity: HelperPermissionSubjectIdentity,
  options: OpenCuaAccessibilitySettingsOptions,
  phase: "launch" | "post-settings",
): Promise<CuaHelperBundleFingerprint> {
  const fingerprint = captureCuaHelperBundleFingerprint(identity.appPath);
  await options.verifyHelperInstalled?.(identity.appPath);
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(`ZCode Computer Use changed while its ${phase} signature was being verified`);
  }
  const currentIdentity = await (
    options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
  )(identity.appPath);
  if (!sameHelperPermissionIdentity(identity, currentIdentity)) {
    throw new Error(`ZCode Computer Use permission identity changed during ${phase} verification`);
  }
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(
      `ZCode Computer Use changed while its ${phase} permission identity was being resolved`,
    );
  }
  return fingerprint;
}

type CuaHelperInstallerLogger = NonNullable<CuaHelperInstallerOptions["logger"]>;

function toInstallerLogger(
  logger: OpenCuaAccessibilitySettingsOptions["logger"],
): CuaHelperInstallerLogger | undefined {
  if (!logger) return undefined;
  return {
    debug: (_traceId, ...args) => logger.debug?.(...args),
    info: (_traceId, ...args) => (logger.info ?? logger.warn)(...args),
    warn: (_traceId, ...args) => logger.warn(...args),
    error: (_traceId, ...args) => (logger.error ?? logger.warn)(...args),
  };
}

interface ActiveOnboardingSession {
  identity: HelperPermissionSubjectIdentity;
  sessionId: string;
  controller: AbortController;
  activeParticipants: Set<number>;
  requiredPermissions: Set<CuaPermissionKind>;
  processedPermissions: Set<CuaPermissionKind>;
  openedPermissions: CuaPermissionKind[];
  acceptingRequirements: boolean;
  recoveryOwnerParticipantKeys: Set<string>;
  /**
   * Verification fingerprint evidence rebuilt for each stage and consumed by the synchronous comparison before dragstart
   * (TCC binds the bundle that is dropped).
   */
  launchFingerprint?: CuaHelperBundleFingerprint;
  promise?: Promise<CuaAccessibilitySettingsResult>;
}

/**
 * Main-process coordinator. Its key uses the Helper's exact authorization identity rather than renderer/window/workspace:
 * macOS TCC recognizes only this authorization subject, and concurrent native prompts for the same subject steal focus
 * from each other and can leave an unrecoverable intermediate state.
 */
class CuaPermissionOnboardingCoordinator {
  private readonly sessions = new Map<string, ActiveOnboardingSession>();
  private nextParticipantId = 0;

  constructor(private readonly createSessionId: () => string = randomUUID) {}

  run(
    identity: HelperPermissionSubjectIdentity,
    requiredPermissions: CuaPermissionKind[],
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    // bundle id + displayName are not an exact Helper identity. During development/upgrade, bundles at different paths
    // or with different executables can share these strings. Merging their sessions would bind later windows' permission
    // results and recovery rights to the first app. The coordination key covers every immutable post-verification identity field,
    // isolating any path/executable change.
    const identityKey = [
      identity.bundleId,
      identity.displayName,
      identity.appPath,
      identity.executablePath,
    ].join("\0");
    const existing = this.sessions.get(identityKey);
    if (existing?.promise) {
      if (existing.acceptingRequirements) {
        for (const permission of requiredPermissions) {
          existing.requiredPermissions.add(permission);
        }
        options.logger?.info?.(
          "[cua-permission-onboarding] joined active Helper permission session",
          existing.sessionId,
          identity.bundleId,
        );
        return this.joinSession(existing, options.signal, options.participantKey);
      }
      // The previous session has terminated, but asynchronous cleanup for this exact permission Helper is unfinished.
      // Wait until the identity key is actually released before retrying; do not overlap a new session with a late LaunchServices instance.
      return existing.promise.then(() => {
        if (options.signal?.aborted) {
          return this.canceledParticipantResult(existing, options.signal.reason);
        }
        return this.run(identity, requiredPermissions, options);
      });
    }

    const session: ActiveOnboardingSession = {
      identity,
      sessionId: this.createSessionId(),
      controller: new AbortController(),
      activeParticipants: new Set(),
      requiredPermissions: new Set(requiredPermissions),
      processedPermissions: new Set(),
      openedPermissions: [],
      acceptingRequirements: true,
      recoveryOwnerParticipantKeys: new Set(),
    };
    const promise = this.runSession(session, options).finally(() => {
      if (this.sessions.get(identityKey) === session) {
        this.sessions.delete(identityKey);
      }
    });
    session.promise = promise;
    this.sessions.set(identityKey, session);
    return this.joinSession(session, options.signal, options.participantKey);
  }

  private joinSession(
    session: ActiveOnboardingSession,
    signal?: AbortSignal,
    participantKey?: string,
  ): Promise<CuaAccessibilitySettingsResult> {
    this.nextParticipantId += 1;
    const participantId = this.nextParticipantId;
    const recoveryParticipantKey = participantKey?.trim() || `participant:${participantId}`;
    session.activeParticipants.add(participantId);

    return new Promise<CuaAccessibilitySettingsResult>((resolve) => {
      let active = true;
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        session.activeParticipants.delete(participantId);
      };
      const onAbort = () => {
        if (!active) return;
        active = false;
        detach();
        resolve(this.canceledParticipantResult(session, signal?.reason));
        if (session.activeParticipants.size === 0 && !session.controller.signal.aborted) {
          // A shared session must not be owned exclusively by the first caller's signal. Closing any window removes only
          // that participant; cancel the native flow only when the last participant leaves, and close the requirement join
          // gate first so later explicit retries wait for exact cleanup.
          session.acceptingRequirements = false;
          session.controller.abort(
            signal?.reason ?? new Error("all CUA permission onboarding windows closed"),
          );
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      void session.promise!.then((result) => {
        if (!active) return;
        active = false;
        detach();
        const returned =
          result.success === true &&
          result.returnedFromSettings === true &&
          typeof result.sessionId === "string";
        // Promise continuations run serially in the main event loop. Repeated calls from one renderer/webContents grant
        // recovery only once; different windows have separate hosts/Helpers and each must get recovery once, so do not deduplicate globally.
        const ownsRecovery =
          returned && !session.recoveryOwnerParticipantKeys.has(recoveryParticipantKey);
        if (ownsRecovery) session.recoveryOwnerParticipantKeys.add(recoveryParticipantKey);
        resolve({
          ...result,
          ...(returned ? { restartHelperAfterReturn: ownsRecovery } : {}),
        });
      });
    });
  }

  private canceledParticipantResult(
    session: ActiveOnboardingSession,
    reason: unknown,
  ): CuaAccessibilitySettingsResult {
    return {
      success: false,
      canceled: true,
      sessionId: session.sessionId,
      returnedFromSettings: false,
      error: `permission onboarding canceled: ${messageOf(
        reason ?? new Error("origin window closed"),
      )}`,
    };
  }

  private async runSession(
    session: ActiveOnboardingSession,
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    const configuredSessionTimeoutMs = options.sessionTimeoutMs;
    const sessionTimeoutMs =
      typeof configuredSessionTimeoutMs === "number" && Number.isFinite(configuredSessionTimeoutMs)
        ? Math.max(1, configuredSessionTimeoutMs)
        : null;
    const startedAt = Date.now();
    const controller = session.controller;
    const sessionTimer =
      sessionTimeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new Error(`CUA permission onboarding session exceeded ${sessionTimeoutMs}ms`),
              ),
            sessionTimeoutMs,
          );
    let returnedCount = 0;

    try {
      while (true) {
        const permission = PERMISSION_STAGE_ORDER.find(
          (candidate) =>
            session.requiredPermissions.has(candidate) &&
            !session.processedPermissions.has(candidate),
        );
        if (!permission) {
          // The final identity check after the last page returns still awaits. If the join gate remains open, a new
          // permission request could silently join after the while loop ends and receive a false success. Close the gate
          // synchronously so later requests wait for cleanup and then start a new session.
          session.acceptingRequirements = false;
          break;
        }
        session.processedPermissions.add(permission);
        const remainingMs =
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : sessionTimeoutMs - (Date.now() - startedAt);
        if (Number.isFinite(remainingMs) && remainingMs <= 0) {
          controller.abort(new Error("CUA permission onboarding session timed out"));
          throw controller.signal.reason;
        }
        // Do not reuse verification evidence from the first ensureInstalled across the time the user spends in Settings.
        // A same-UID process could replace the install directory before the next stage, directing permission to another bundle.
        // Rebuild evidence for every stage in this order: pre-fingerprint snapshot → full verify → exact identity check →
        // post-fingerprint snapshot. Any change fails closed.
        //
        // The final comparison is synchronous before dragstart. The user adds the Helper to TCC by dragging it, and TCC
        // binds the exact dropped bundle, so proving that its bytes have not changed just before the drop matches the
        // actual risk. Store the fingerprint on the session for the drag cache (see desktopCuaPermissionIpc).
        session.launchFingerprint = await verifyHelperPermissionIdentityUnchanged(
          session.identity,
          options,
          "launch",
        );
        if (controller.signal.aborted) throw controller.signal.reason;

        const openSettingsUrl =
          options.openSettingsUrl ?? ((url: string) => shell.openExternal(url));
        const openSettings = async () => {
          await openSettingsUrl(settingsUrlForPermission(permission));
          if (!session.openedPermissions.includes(permission)) {
            session.openedPermissions.push(permission);
          }
        };
        const returnTimeoutMs = Math.min(
          options.settingsReturnTimeoutMs ?? DEFAULT_SETTINGS_RETURN_TIMEOUT_MS,
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : Math.max(1, sessionTimeoutMs - (Date.now() - startedAt)),
        );
        if (options.openSettingsAndWaitForReturn) {
          await options.openSettingsAndWaitForReturn({
            permission,
            sessionId: session.sessionId,
            timeoutMs: returnTimeoutMs,
            signal: controller.signal,
            openSettings,
          });
          if (controller.signal.aborted) throw controller.signal.reason;
          returnedCount += 1;
        } else {
          // The old interface has no main return signal: preserve its "open Settings" compatibility behavior, but never fake return=true.
          await openSettings();
          if (controller.signal.aborted) throw controller.signal.reason;
        }
      }

      // The Helper could still be upgraded/replaced between the last page returning and restart. Background IPC refresh
      // of the drag cache is not evidence for this authorization. Verify again and bind the same identity before success;
      // on change, fail closed and do not grant recovery rights.
      if (session.openedPermissions.length > 0) {
        await verifyHelperPermissionIdentityUnchanged(session.identity, options, "post-settings");
        if (controller.signal.aborted) throw controller.signal.reason;
      }
      return {
        success: true,
        sessionId: session.sessionId,
        returnedFromSettings:
          session.openedPermissions.length > 0 &&
          returnedCount === session.openedPermissions.length,
        error: undefined,
      };
    } catch (error) {
      session.acceptingRequirements = false;
      return {
        success: false,
        canceled: controller.signal.aborted || undefined,
        sessionId: session.sessionId,
        returnedFromSettings: false,
        error: `permission onboarding failed: ${messageOf(error)}`,
      };
    } finally {
      if (sessionTimer) clearTimeout(sessionTimer);
    }
  }
}

const mainCuaPermissionOnboardingCoordinator = new CuaPermissionOnboardingCoordinator();

export async function openCuaPermissionOnboarding(
  options: OpenCuaAccessibilitySettingsOptions = {},
): Promise<CuaAccessibilitySettingsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  let helperAppPath: string;
  try {
    helperAppPath = await (options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled)();
  } catch (error) {
    // Security boundary: installation/verification failures must fail closed. Never fall back to an unverified Helper just
    // because its path exists; that could guide the user to grant Accessibility / Screen Recording to an old version,
    // invalid signature, wrong Team, or replaced bundle, violating the core boundary that the Helper is an independent
    // authorization subject pinned by TeamIdentifier. The installer handles development through
    // ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: if dev verification succeeds, ensureInstalled returns the local app normally
    // and never reaches this catch. Only actual verification failures reach it.
    return {
      success: false,
      error: `ZCode Computer Use is unavailable (install/verification failed): ${messageOf(error)}`,
    };
  }

  let identity: HelperPermissionSubjectIdentity;
  try {
    identity = await (options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity)(
      helperAppPath,
    );
  } catch (error) {
    return {
      success: false,
      returnedFromSettings: false,
      error: `ZCode Computer Use permission identity verification failed: ${messageOf(error)}`,
    };
  }
  const verifiedOptions: OpenCuaAccessibilitySettingsOptions = {
    ...options,
    ...(options.verifyHelperInstalled
      ? { verifyHelperInstalled: options.verifyHelperInstalled }
      : defaultInstaller
        ? { verifyHelperInstalled: defaultInstaller.verifyInstalled }
        : {}),
  };
  return mainCuaPermissionOnboardingCoordinator.run(
    identity,
    normalizeRequiredPermissions(options),
    verifiedOptions,
  );
}

// A 2026-08 audit removed the drag path as dead code (the renderer had no caller then, and onboarding used a native prompt
// to add the Helper to the TCC list automatically). Once that prompt was removed, dragging became the only way to add the
// Helper to the permission list, so restore this function. Do not restore openCuaAccessibilitySettings (the old confirmation
// dialog channel); onboarding replaced it.

interface PrepareCuaHelperPermissionDragOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: OpenCuaAccessibilitySettingsOptions["logger"];
  /** Install and verify through the desktop installer factory shared with onboarding; tests can inject it. */
  ensureHelperInstalled?: () => Promise<string>;
  bundledHelperAppPath?: string;
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
}

export interface PrepareCuaHelperPermissionDragMainResult extends PrepareCuaHelperPermissionDragResult {
  /**
   * Synchronous bundle fingerprint bound to the full verification before and after this operation. Only the in-memory
   * main cache may consume it; IPC handlers must strip this field before returning to the renderer (cross-process exposure
   * is useless and expands the attack surface).
   */
  helperBundleFingerprint?: CuaHelperBundleFingerprint;
}

// Drag authorization and onboarding lead to the same TCC authorization subject, so their security checks must match.
// If an old, badly signed, wrong-Team, or same-user-replaced .app is dropped into Accessibility/Screen Recording, TCC
// grants permission to the wrong subject and bypasses TeamIdentifier pinning. Run the same install+verify before dragging
// (bundle ID / version / architecture / codesign / TeamIdentifier / Gatekeeper).
//
// Electron native file dragging requires a synchronous event.sender.startDrag() call in the dragstart event chain.
// It cannot wait for asynchronous I/O without missing the OS drag gesture window. Therefore this function performs
// install+verify ahead of time: warm the cache with the verified path and fingerprint when the panel mounts, then have
// dragstart read and compare the cache synchronously (see desktopCuaPermissionIpc).
export async function prepareCuaHelperPermissionDrag(
  options: PrepareCuaHelperPermissionDragOptions = {},
): Promise<PrepareCuaHelperPermissionDragMainResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  try {
    const helperAppPath = await (
      options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled
    )();
    // Order matters: take a snapshot first, run full verification, then recheck after signature verification and identity
    // reading. If the fingerprint were captured only after ensure/verify returns, an attacker could replace the .app in
    // between and make malicious bytes the "verified fingerprint". Only the same unchanged bytes throughout may be stored
    // in the synchronous dragstart cache.
    const verifiedFingerprint = captureCuaHelperBundleFingerprint(helperAppPath);
    await (options.verifyHelperInstalled ?? defaultInstaller?.verifyInstalled)?.(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag signature was being verified");
    }
    const identity = await (
      options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
    )(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag identity was being resolved");
    }
    return {
      success: true,
      helperAppPath,
      helperDisplayName: identity.displayName,
      helperBundleId: identity.bundleId,
      helperBundleFingerprint: verifiedFingerprint,
    };
  } catch (error) {
    const message = messageOf(error);
    options.logger?.warn(
      "[cua-permission-onboarding] helper install/verify failed; refusing to prepare drag of an unverified Helper",
      message,
    );
    return { success: false, error: message };
  }
}
