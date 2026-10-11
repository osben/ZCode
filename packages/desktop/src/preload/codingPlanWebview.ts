import { contextBridge, ipcRenderer } from "electron";
import {
  CodingPlanWebviewChannels,
  isTrustedCodingPlanWebviewOrigin,
  PlatformChannels,
} from "@zcode/shared";

// Preload for the Coding Plan website:
// - Exposes window.zcodeBridge in the website's main world with these capabilities:
//   1) notifyPurchaseComplete: notify the host renderer through sendToHost after a purchase;
//   2) getLang / onLangChange: read the App's current locale and subscribe to runtime changes;
//   3) getReportContext: read purchase-source context injected by the App;
//   4) openExternal: open external links in the system browser. An in-webview <a target="_blank"> is
//      normally routed to an internal Browser tab by setWindowOpenHandler, but the website wants links
//      such as terms or account management to open in the system browser. Its script intercepts them and
//      forwards the request through this method.
// - getLang reads window.__zcodeLang__ in the main world (injected by App.executeJavaScript).
//   onLangChange listens in the main world for the zcode-coding-plan-lang-change CustomEvent, also
//   dispatched by App.executeJavaScript when the locale changes. The whole bridge is installed in the
//   main world through contextBridge.executeInMainWorld, so the page script shares the same window and
//   can receive the event.
// - The website's main world cannot access Node or ipcRenderer primitives; it receives only product APIs.
// Follow the contextBridge.executeInMainWorld pattern in embeddedBrowserJavaScriptDialog.ts, which works
// with sandbox=true + contextIsolation=true and already has a precedent.
//
// Injection timing: when the Electron webview's will-attach-webview hook identifies the official
// purchase page from params.src, it switches webPreferences.preload to this file (see desktopWindowChrome.ts).

const PUBLIC_BRIDGE_KEY = "zcodeBridge";
const NATIVE_BRIDGE_KEY = "__zcodeCodingPlanWebviewNativeBridge__";
const LANG_VAR = "__zcodeLang__";
const LANG_CHANGE_EVENT = "zcode-coding-plan-lang-change";
const REPORT_CONTEXT_VAR = "__zcodeReportContext__";

function isTrustedCodingPlanBridgeLocation(): boolean {
  try {
    const url = new URL(window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    if (url.searchParams.get("embedded") === "app") return true;
    // The PayPal return page itself does not include embedded=app, but returnTo points back to the
    // embedded purchase page. After payment succeeds, that page still needs
    // zcodeBridge.notifyPurchaseComplete to tell the App to refresh model settings.
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return (
      target.origin === url.origin &&
      target.pathname.includes("coding-plan") &&
      target.searchParams.get("embedded") === "app" &&
      !target.pathname.endsWith("/coding-plan/payment/callback")
    );
  } catch {
    return false;
  }
}

interface NotifyPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
}

type CodingPlanReportContext = Record<string, string>;

interface CodingPlanNativeBridge {
  notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload): void;
  openExternal(url: string): void;
}

// The Coding Plan guest reuses this preload configuration when navigating to PayPal.
// Expose the bridge only to the trusted official purchase page so third-party authorization pages do not
// inherit App communication capabilities.
if (isTrustedCodingPlanBridgeLocation()) {
  contextBridge.exposeInMainWorld(NATIVE_BRIDGE_KEY, {
    notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload) {
      try {
        ipcRenderer.sendToHost(CodingPlanWebviewChannels.PurchaseComplete, {
          provider: payload.provider,
          timestamp: Date.now(),
        } satisfies import("@zcode/shared").CodingPlanPurchaseCompletePayload);
      } catch {
        // sendToHost throws if the host renderer is not attached or the webview has been destroyed.
        // The website does not depend on this call succeeding, so ignore that case.
      }
    },
    openExternal(url: string) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        ipcRenderer.send(PlatformChannels.OpenExternal, {
          sourceUrl: window.location.href,
          url: parsed.toString(),
        });
      } catch {
        // Ignore invalid URLs so the website cannot send arbitrary IPC payloads through the bridge.
      }
    },
  } satisfies CodingPlanNativeBridge);

  contextBridge.executeInMainWorld({
    func: (
      publicBridgeKey: string,
      nativeBridgeKey: string,
      langVar: string,
      langChangeEvent: string,
      reportContextVar: string,
    ) => {
      const nativeBridge = (
        window as unknown as Record<string, CodingPlanNativeBridge | undefined>
      )[nativeBridgeKey];
      if (!nativeBridge) return;
      const bridge = {
        notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload) {
          if (payload?.provider !== "zai" && payload?.provider !== "bigmodel") {
            return;
          }
          nativeBridge.notifyPurchaseComplete(payload);
        },
        // Return the App's current locale; null means the App has not injected one yet, which the website
        // uses to detect whether it is embedded.
        getLang() {
          // Note: executeInMainWorld does not compile its function body with TypeScript, so do not use
          // TypeScript syntax such as `as` assertions.
          const value = (window as unknown as Record<string, unknown>)[langVar];
          return value === "zh-CN" || value === "en-US" ? value : null;
        },
        getReportContext() {
          const value = (window as unknown as Record<string, unknown>)[reportContextVar];
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          return value as CodingPlanReportContext;
        },
        // Subscribe to runtime locale changes from the App and return an unsubscribe function.
        // When the App locale changes, it dispatches zcode-coding-plan-lang-change through executeJavaScript.
        onLangChange(callback: (locale: "zh-CN" | "en-US") => void) {
          const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ locale?: unknown }>).detail;
            if (detail && (detail.locale === "zh-CN" || detail.locale === "en-US")) {
              callback(detail.locale);
            }
          };
          window.addEventListener(langChangeEvent, handler);
          return () => window.removeEventListener(langChangeEvent, handler);
        },
        openExternal(url: string) {
          nativeBridge.openExternal(url);
        },
      };
      Object.defineProperty(window, publicBridgeKey, {
        value: bridge,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    },
    args: [PUBLIC_BRIDGE_KEY, NATIVE_BRIDGE_KEY, LANG_VAR, LANG_CHANGE_EVENT, REPORT_CONTEXT_VAR],
  });
}
