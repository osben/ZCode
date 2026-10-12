import type { Session, Streams } from "electron";
import type { EmbeddedBrowserPermissionDeviceOption } from "@zcode/shared";
import { readDeviceOptions } from "./embeddedBrowserDeviceOptions.js";
import {
  getEmbeddedBrowserSitePermission,
  initEmbeddedBrowserSitePermissions,
  writeEmbeddedBrowserSitePermission,
} from "./embeddedBrowserSitePermissions.js";

/**
 * Permission gate for the embedded browser partition (fix for the CNVD "embedded browser
 * unauthorized access" finding; spec at
 * docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md).
 *
 * An Electron session without a permission handler auto-approves every permission request, so a
 * malicious page can silently obtain camera/microphone/clipboard/geolocation; when no select-*
 * events are listened to, device-class APIs additionally auto-grant the first matching device.
 * This module registers default-deny request/check/device/displayMedia handlers on that
 * partition: harmless permissions pass via allowlist, sensitive permissions go through a
 * product-level dialog for the user to decide, and everything else fails closed.
 *
 * Staged rollout: while the prompt is not injected, sensitive permissions are always denied
 * (security closure first); once the dialog layer is wired in, user choices are written back to
 * the in-memory sessionAllow or the persistent store.
 */

export const EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS: ReadonlySet<string> = new Set([
  // clipboard-sanitized-write backs web pages' "copy" buttons, fullscreen/pointerLock back video
  // fullscreen and interaction, mediaKeySystem backs DRM video playback: denying them causes
  // widespread functional breakage, and none of them leak user data.
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "mediaKeySystem",
]);

const PROMPT_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "clipboard-read",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "idle-detection",
  "speaker-selection",
  "window-management",
  "storage-access",
  "top-level-storage-access",
  "keyboardLock",
  "fileSystem",
]);

/** Device-class permissions in the check handler's enum: pass through to the select-* chooser (see the check handler comment). */
const DEVICE_CHECK_PERMISSIONS: ReadonlySet<string> = new Set(["usb", "hid", "serial"]);

export type EmbeddedBrowserPermissionPromptAction =
  | "allow-always"
  | "allow-session"
  | "block-always"
  | "dismiss";

export interface EmbeddedBrowserPermissionPromptRequest {
  origin: string;
  permission: string;
  mediaTypes?: readonly string[];
  /** webContents id of the host renderer of the guest that triggered the request; the dialog uses it to route to the correct window. */
  hostWebContentsId?: number;
  /** webContents id of the requesting guest itself; the renderer uses it to render only in the owning tab. */
  guestWebContentsId?: number;
}

export interface EmbeddedBrowserSitePermissionRecord {
  [origin: string]: { [permission: string]: "allow" | "deny" };
}

export interface EmbeddedBrowserSitePermissionStore {
  load(): Promise<EmbeddedBrowserSitePermissionRecord>;
  persist(record: EmbeddedBrowserSitePermissionRecord): Promise<void>;
}

export interface EmbeddedBrowserPermissionLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export type EmbeddedBrowserPermissionSession = Session;

export interface EmbeddedBrowserDevicePickerSession {
  result: Promise<{ deviceId: string } | null>;
  updateDevices(devices: EmbeddedBrowserPermissionDeviceOption[]): void;
}

export interface EmbeddedBrowserPermissionPolicyOptions {
  logger: EmbeddedBrowserPermissionLogger;
  /** Injected by the dialog layer (Step 2); when absent, sensitive permissions are always denied. */
  prompt?: (
    request: EmbeddedBrowserPermissionPromptRequest,
  ) => Promise<EmbeddedBrowserPermissionPromptAction>;
  /** Persistent site-consent record (Step 2/3); when absent, decisions rely on memory only. */
  store?: EmbeddedBrowserSitePermissionStore;
  /**
   * Injected by the device picker (Step 2); returns a session handle: result settles the picked
   * deviceId (null cancels), updateDevices hot-updates the device list while the picker is open
   * (Bluetooth scanning / USB enumeration fire select-* continuously; only one picker per
   * permission). When absent, select-* is always cancelled (blocking Electron's default of
   * silently granting the first device).
   */
  devicePicker?: (input: {
    origin: string;
    permission: string;
    devices: EmbeddedBrowserPermissionDeviceOption[];
    hostWebContentsId?: number;
    guestWebContentsId?: number;
  }) => EmbeddedBrowserDevicePickerSession;
  /**
   * Injected by the screen-share source picker (Step 2); the source list and callback semantics
   * need desktopCapturer context, so everything is forwarded to the bridge and the policy keeps
   * only logging and default-deny.
   */
  onDisplayMediaRequest?: (
    input: { origin: string },
    callback: (result: unknown) => void,
  ) => void;
}

export const EMBEDDED_BROWSER_PERMISSION_LOG_TAG = "[embedded-browser-permission]";
const LOG_TAG = EMBEDDED_BROWSER_PERMISSION_LOG_TAG;
const UNKNOWN_ORIGIN = "unknown";

export function originFromUrl(url: string | undefined): string {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return UNKNOWN_ORIGIN;
  }
}


export async function applyEmbeddedBrowserPermissionPolicy(
  targetSession: EmbeddedBrowserPermissionSession,
  options: EmbeddedBrowserPermissionPolicyOptions,
): Promise<void> {
  const { logger } = options;

  // The site-consent record stays resident in memory (the check handler reads it synchronously);
  // a dedicated manager handles loading and persistence, and the settings page's "site
  // permissions" and "clear browser data" go through the same manager so the decision criteria
  // stay consistent.
  await initEmbeddedBrowserSitePermissions({
    ...(options.store ? { store: options.store } : {}),
    logger,
  });

  const sessionAllow = new Map<string, Set<string>>();
  const inflight = new Map<string, Promise<EmbeddedBrowserPermissionPromptAction>>();

  const logDecision = (
    decision: "granted" | "denied",
    meta: Record<string, unknown>,
    warn = false,
  ): void => {
    const message = `${LOG_TAG} decision=${decision}`;
    if (warn) logger.warn(message, meta);
    else logger.info(message, meta);
  };

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // details is Electron's union of four PermissionRequest kinds (media carries mediaTypes,
    // fileSystem carries filePaths, etc.); read here via targeted assertions without structural assumptions.
    const requestingUrl = (details as { requestingUrl?: string }).requestingUrl;
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    const origin = originFromUrl(requestingUrl);
    // The guest's host renderer is the window where the dialog should show; in non-webview cases it falls back to the guest itself.
    const hostWebContentsId = webContents.hostWebContents?.id ?? webContents.id;
    const guestWebContentsId = webContents.id;

    if (EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) {
      logDecision("granted", { permission, origin, source: "allowlist" });
      callback(true);
      return;
    }

    if (PROMPT_PERMISSIONS.has(permission)) {
      const persisted = getEmbeddedBrowserSitePermission(origin, permission);
      if (persisted === "allow" || persisted === "deny") {
        logDecision(persisted === "allow" ? "granted" : "denied", {
          permission,
          origin,
          source: "site-setting",
        });
        callback(persisted === "allow");
        return;
      }
      if (sessionAllow.get(origin)?.has(permission)) {
        logDecision("granted", { permission, origin, source: "session-allow" });
        callback(true);
        return;
      }
      if (!options.prompt) {
        logDecision("denied", { permission, origin, source: "default-deny" });
        callback(false);
        return;
      }
      // Concurrent requests with the same origin+permission share one dialog (the same inflight pattern as pluginSandbox's permissionGate).
      const key = `${origin}|${permission}`;
      let flight = inflight.get(key);
      if (!flight) {
        flight = options
          .prompt({
            origin,
            permission,
            hostWebContentsId,
            guestWebContentsId,
            ...(mediaTypes ? { mediaTypes } : {}),
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, flight);
      }
      void flight.then(
        (action) => {
          const granted = action === "allow-always" || action === "allow-session";
          logDecision(granted ? "granted" : "denied", {
            permission,
            origin,
            source: "user-prompt",
            action,
          });
          if (action === "allow-always") {
            void writeEmbeddedBrowserSitePermission(origin, permission, "allow");
          }
          else if (action === "allow-session") {
            const grantedSet = sessionAllow.get(origin) ?? new Set<string>();
            grantedSet.add(permission);
            sessionAllow.set(origin, grantedSet);
          } else if (action === "block-always") {
            void writeEmbeddedBrowserSitePermission(origin, permission, "deny");
          }
          callback(granted);
        },
        (error: unknown) => {
          logger.warn(`${LOG_TAG} permission prompt failed: ${String(error)}`);
          callback(false);
        },
      );
      return;
    }

    // openExternal is handled by the embedded browser's existing window-opening routing;
    // unrecognized permissions fail closed to prevent new enum values in future Electron versions
    // from bypassing the allowlist.
    logDecision("denied", { permission, origin, source: "default-deny" }, true);
    callback(false);
  });

  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) return true;
    // Device-class permission checks: returning false here was observed to block
    // requestDevice/requestPort dead at the check layer (zero select-* logs, the page gets
    // NotAllowedError) and the chooser never fires — the select-serial-port docs state explicitly
    // that the serial permission is governed by the check handler. Like setDevicePermissionHandler
    // always-true, this passes through to the chooser; actual device authorization is gated
    // exclusively by the select-* listeners (no selection, no grant). Bluetooth is not in the
    // check enum and is unaffected.
    if (DEVICE_CHECK_PERMISSIONS.has(permission)) return true;
    if (!PROMPT_PERMISSIONS.has(permission)) return false;
    if (getEmbeddedBrowserSitePermission(requestingOrigin, permission) === "allow") return true;
    return sessionAllow.get(requestingOrigin)?.has(permission) === true;
  });

  // Semantics correction from testing: setDevicePermissionHandler returning false blocks
  // requestDevice outright (NotAllowedError) and the select-* chooser never fires (USB/HID/Serial
  // requests on permission.site once produced no dialog and no select logs because of this). The
  // real security gate is the select-* listeners below: only when they are not listened to does
  // Electron silently grant the first device. We always register the listeners in apply
  // (unit-test asserted), so the handler's always-true only means "pass through to the chooser"
  // and does not constitute a grant.
  targetSession.setDevicePermissionHandler(() => true);

  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = (request as { frame?: { url?: string } }).frame?.url;
    const origin = originFromUrl(frameUrl);
    if (options.onDisplayMediaRequest) {
      // Source picking needs the desktopCapturer context and Electron-specific callback semantics; forward everything to the bridge.
      logDecision("granted", { permission: "display-capture", origin, source: "source-picker" });
      options.onDisplayMediaRequest({ origin }, (result) => callback(result as Streams));
      return;
    }
    logDecision("denied", { permission: "display-capture", origin, source: "default-deny" });
    callback({});
  });

  // When no select-* events are listened to, Electron silently grants the first matching device;
  // registering the listeners blocks that path. Cancel semantics: hid/usb take no argument,
  // serial takes an empty string. Once the device picker is injected, the deviceId is called back
  // per the user's choice.
  const cancelArgFor = (permission: string): string | undefined =>
    permission === "select-hid-device" || permission === "select-usb-device" ? undefined : "";

  // Only one device picker per permission globally: select-* events fire continuously during
  // device discovery (Bluetooth scanning surfaces devices progressively, same for USB
  // enumeration); later fires only hot-update the list. Chromium's semantics are "repeated fires
  // of the same request before the callback settles", so the callbacks carried by later fires are
  // no longer invoked.
  const devicePickerSessions = new Map<string, EmbeddedBrowserDevicePickerSession>();

  const settleDeviceSelection = (
    permission: string,
    input: {
      origin: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      hostWebContentsId?: number;
      guestWebContentsId?: number;
    },
    callback: (value?: string) => void,
  ): void => {
    const cancel = cancelArgFor(permission);
    if (!options.devicePicker) {
      logDecision("denied", { permission, origin: input.origin, source: "device-picker" });
      callback(cancel);
      return;
    }
    const existing = devicePickerSessions.get(permission);
    if (existing) {
      // Diagnose Bluetooth/USB progressive enumeration: record the visible device count on hot-update (an empty list helps locate TCC permission issues)
      logger.info(`${LOG_TAG} device list updated`, {
        permission,
        origin: input.origin,
        deviceCount: input.devices.length,
      });
      existing.updateDevices(input.devices);
      return;
    }
    let session: EmbeddedBrowserDevicePickerSession;
    try {
      session = options.devicePicker({ ...input, permission });
    } catch (error) {
      logger.warn(`${LOG_TAG} device picker failed: ${String(error)}`);
      callback(cancel);
      return;
    }
    devicePickerSessions.set(permission, session);
    logger.info(`${LOG_TAG} device picker opened`, {
      permission,
      origin: input.origin,
      deviceCount: input.devices.length,
    });
    void session.result.then(
      (picked) => {
        devicePickerSessions.delete(permission);
        if (!picked) {
          logDecision("denied", { permission, origin: input.origin, source: "device-picker" });
          callback(cancel);
          return;
        }
        logDecision("granted", { permission, origin: input.origin, source: "device-picker" });
        callback(picked.deviceId);
      },
      (error: unknown) => {
        devicePickerSessions.delete(permission);
        logger.warn(`${LOG_TAG} device picker failed: ${String(error)}`);
        callback(cancel);
      },
    );
  };

  // hid/usb: (event, details { deviceList, frame }, callback)
  const handleFramedDeviceSelection = (permission: string) => {
    return (event: unknown, details: unknown, callback: (value?: string) => void) => {
      // The default behavior must be prevented, otherwise Chromium cancels the page's request
      // immediately after the event fires with "no device selected" and the async callback cannot
      // take effect (controlled experiment: with preventDefault added, a 4s async selection works).
      (event as { preventDefault?: () => void }).preventDefault?.();
      const frameUrl = (details as { frame?: { url?: string } | null })?.frame?.url;
      const deviceList = (details as { deviceList?: unknown })?.deviceList;
      settleDeviceSelection(
        permission,
        {
          origin: originFromUrl(frameUrl),
          devices: readDeviceOptions(deviceList),
        },
        callback,
      );
    };
  };
  targetSession.on("select-hid-device", handleFramedDeviceSelection("select-hid-device"));
  targetSession.on("select-usb-device", handleFramedDeviceSelection("select-usb-device"));

  // serial: (event, portList, webContents, callback(portId: string)); empty string cancels
  targetSession.on(
    "select-serial-port",
    (
      event: unknown,
      portList: unknown,
      webContents: unknown,
      callback: (portId: string) => void,
    ) => {
      // Same as hid/usb: prevent the default cancel and wait for the user's choice.
      (event as { preventDefault?: () => void }).preventDefault?.();
      const contents = webContents as
        | { hostWebContents?: { id?: number }; id?: number; getURL?: () => string }
        | null;
      const hostWebContentsId = contents?.hostWebContents?.id ?? contents?.id;
      settleDeviceSelection(
        "select-serial-port",
        {
          origin: originFromUrl(contents?.getURL?.()),
          devices: readDeviceOptions(portList),
          ...(hostWebContentsId !== undefined ? { hostWebContentsId } : {}),
        },
        (value) => callback(value ?? ""),
      );
    },
  );
}

