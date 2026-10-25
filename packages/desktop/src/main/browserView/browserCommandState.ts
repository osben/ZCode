import type { BrowserPageState } from "@zcode/shared";
import type { ControlledViewWebContents } from "./browserCommandTypes.js";

/**
 * The default navigation budget is 10 seconds. A timeout or real loadURL error must return a failure;
 * do not swallow the error and report success, or the model may build locators on the wrong page.
 */
export const DEFAULT_NAVIGATE_SETTLE_MS = 10_000;

export class BrowserNavigationTimeoutError extends Error {
  override name = "BrowserNavigationTimeoutError";
}

/**
 * Browser navigation allowlist: permit only http/https and the exact about:blank URL.
 * Do not allow arbitrary about:* URLs.
 */
export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank") return true;
  try {
    const u = new URL(rawUrl);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function now(): number {
  return Date.now();
}

export function readState(wc: ControlledViewWebContents): BrowserPageState {
  return {
    url: safe(() => wc.getURL(), ""),
    title: safe(() => wc.getTitle(), ""),
    canGoBack: safe(() => wc.canGoBack(), false),
    canGoForward: safe(() => wc.canGoForward(), false),
  };
}

/** Race loadURL against timeout/cancellation; navigation succeeds only when it actually completes. */
export async function settleNavigation(
  loadPromise: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new BrowserNavigationTimeoutError(`Navigation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([loadPromise, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
