import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { installEmbeddedBrowserWheelForwarding } from "./embeddedBrowserWheel.js";

const BRIDGE_KEY = "__zcodeEmbeddedBrowserJavaScriptDialog__";

if (typeof window !== "undefined") {
  installEmbeddedBrowserWheelForwarding(window, (channel, payload) => {
    ipcRenderer.sendToHost(channel, payload);
  });
}

interface DialogBridgeResult {
  handled: boolean;
  value?: boolean;
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  show(type: "alert" | "confirm", message: string): DialogBridgeResult {
    try {
      const result = ipcRenderer.sendSync(PlatformChannels.EmbeddedBrowserJavaScriptDialog, {
        type,
        message,
      }) as unknown;
      if (typeof result !== "object" || result === null) return { handled: false };
      const candidate = result as Partial<DialogBridgeResult>;
      if (candidate.handled !== true) return { handled: false };
      return {
        handled: true,
        ...(typeof candidate.value === "boolean" ? { value: candidate.value } : {}),
      };
    } catch {
      // Fall back to Chromium's native API when main is unavailable; do not swallow the page's dialog.
      return { handled: false };
    }
  },
});

contextBridge.executeInMainWorld({
  func: (bridgeKey: string) => {
    type Bridge = {
      show: (type: "alert" | "confirm", message: string) => DialogBridgeResult;
    };
    const bridge = (window as unknown as Record<string, Bridge | undefined>)[bridgeKey];
    if (!bridge) return;

    const installedConfirmByWindow = new WeakMap<Window, Window["confirm"]>();
    const observedFrames = new WeakSet<HTMLIFrameElement>();

    const installInWindow = (target: Window): void => {
      try {
        if (installedConfirmByWindow.get(target) === target.confirm) return;
        const nativeAlert = target.alert.bind(target);
        const nativeConfirm = target.confirm.bind(target);
        target.alert = (message?: unknown): void => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("alert", text);
          if (!result.handled) nativeAlert(text);
        };
        const wrappedConfirm = (message?: string): boolean => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("confirm", text);
          return result.handled ? result.value === true : nativeConfirm(text);
        };
        target.confirm = wrappedConfirm;
        installedConfirmByWindow.set(target, wrappedConfirm);
      } catch {
        // Cross-origin frames do not let the host read their Window; they load this same preload during real navigation.
      }
    };

    const installFrameTree = (target: Window): void => {
      installInWindow(target);
      try {
        for (const frame of target.document.querySelectorAll("iframe")) {
          if (!observedFrames.has(frame)) {
            observedFrames.add(frame);
            frame.addEventListener(
              "load",
              () => {
                if (frame.contentWindow) installFrameTree(frame.contentWindow);
              },
              true,
            );
          }
          if (frame.contentWindow) installFrameTree(frame.contentWindow);
        }
      } catch {
        // Each frame's own preload handles the frame tree for cross-origin documents.
      }
    };

    installFrameTree(window);
    const observeFrames = (): void => {
      installFrameTree(window);
      const root = window.document?.documentElement;
      if (!root) return;
      // An inherited about:blank iframe without src does not navigate to a document, so Electron does
      // not run a separate preload for it. Watch for its insertion and install the same wrapper from the
      // same-origin parent frame.
      new window.MutationObserver(() => installFrameTree(window)).observe(root, {
        childList: true,
        subtree: true,
      });
    };
    if (window.document?.documentElement) observeFrames();
    else window.addEventListener?.("DOMContentLoaded", observeFrames, { once: true });
  },
  args: [BRIDGE_KEY],
});

/**
 * Electron's Notification.permission getter does not query the session permission handler and
 * always returns denied (an official feature request for a renderer override is still open),
 * so pages show "not granted" after granting. Override it in the main world on the same channel
 * as the JS dialog: present the initial state as undecided (default), then write back the real
 * requestPermission result. Whether new Notification is displayed is still decided internally by
 * Chromium and is unaffected by this override.
 */
contextBridge.executeInMainWorld({
  func: () => {
    try {
      if (typeof Notification === "undefined") return;
      let permissionState: NotificationPermission = "default";
      const nativeRequestPermission = Notification.requestPermission;
      const wrappedRequestPermission = function (
        this: typeof Notification,
        deprecatedCallback?: NotificationPermissionCallback | undefined,
      ): Promise<NotificationPermission> {
        const settled = Promise.resolve(nativeRequestPermission.call(Notification)).then(
          (status: NotificationPermission) => {
            permissionState = status;
            return status;
          },
        );
        if (typeof deprecatedCallback === "function") {
          void settled.then(
            (status) => deprecatedCallback(status),
            () => undefined,
          );
        }
        return settled;
      };
      Notification.requestPermission = wrappedRequestPermission;
      Object.defineProperty(Notification, "permission", {
        get: () => permissionState,
        configurable: true,
      });
    } catch {
      // Page scripts may have locked down Notification; keep native behavior.
    }
  },
  args: [],
});
