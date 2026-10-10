export const DEFAULT_BROWSER_URL = "about:blank";

const RECOVERABLE_BROWSER_GUEST_EXIT_REASONS = new Set([
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "memory-eviction",
]);

/**
 * Recover in place only guests that have run before but were unexpectedly terminated by Chromium.
 *
 * Previously, only the `<webview>` DOM was kept alive; termination of its renderer by the system was not handled.
 * A launch/integrity failure does not mean the original page was reclaimed; rebuilding blindly would create an infinite loop.
 */
export function isRecoverableBrowserGuestExitReason(reason: string): boolean {
  return RECOVERABLE_BROWSER_GUEST_EXIT_REASONS.has(reason);
}

// Synchronous methods on Electron <webview> (getURL/canGoBack/loadURL/executeJavaScript, etc.) can throw
// these two errors before the guest attaches (before dom-ready) or while its frame is destroyed/reattached.
// These are expected webview lifecycle races, not actual application errors. If they are allowed to reach
// the window.onerror global reporter, one source can generate a huge volume of exceptions; handle them at the call boundary.
const WEBVIEW_DETACHED_ERROR_FRAGMENTS = [
  "must be attached to the DOM",
  "Render frame was disposed",
] as const;

function isWebviewDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) {
    return false;
  }
  return WEBVIEW_DETACHED_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * Safely execute one synchronous webview call:
 * - return the call result on success;
 * - when a lifecycle race occurs (such as an unattached guest / destroyed frame), catch it and return the fallback,
 *   optionally record it through onDetached (for debug-level logging, not silently);
 * - rethrow other errors to avoid hiding real bugs.
 */
export function safeWebviewCall<T>(
  call: () => T,
  fallback: T,
  onDetached?: (error: unknown) => void,
): T {
  try {
    return call();
  } catch (error) {
    if (isWebviewDetachedError(error)) {
      onDetached?.(error);
      return fallback;
    }
    throw error;
  }
}

const ALLOWED_BROWSER_PROTOCOLS = new Set(["about:", "data:", "file:", "http:", "https:"]);

const URL_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface BrowserGuestFailure {
  exitCode: number;
  reason: string;
}

export interface BrowserState {
  canGoBack: boolean;
  canGoForward: boolean;
  currentUrl: string;
  errorMessage: string | null;
  /**
   * Chromium net error code for a main-frame load failure.
   *
   * Electron’s `<webview>` has no Chrome safety interstitial, so a blocked navigation ends on a blank
   * chrome-error page that appears black to the user. Keep the error code in state with errorMessage so the UI can render a readable error
   * and provide an override instruction for certificate failures.
   */
  loadErrorCode: number | null;
  /** Process-level failure before the guest has ever rendered successfully; distinct from a load error that can display a readable error state. */
  guestFailure: BrowserGuestFailure | null;
  isLoading: boolean;
  isReady: boolean;
  title: string;
}

export interface BrowserNavigationRequest {
  id: string;
  url: string;
}

export const INITIAL_BROWSER_STATE: BrowserState = {
  canGoBack: false,
  canGoForward: false,
  currentUrl: DEFAULT_BROWSER_URL,
  errorMessage: null,
  loadErrorCode: null,
  guestFailure: null,
  isLoading: false,
  isReady: false,
  title: "",
};

/** Chromium certificate error range (ERR_CERT_COMMON_NAME_INVALID … ERR_CERT_KNOWN_INTERCEPTION_BLOCKED). */
const CERTIFICATE_LOAD_ERROR_CODE_MIN = -217;
const CERTIFICATE_LOAD_ERROR_CODE_MAX = -200;

/**
 * Determine whether a load failure is caused by a certificate issue.
 *
 * Suggest enabling certificate-check bypass only for certificate failures; the same guidance would mislead users for DNS or connection-refused failures.
 */
export function isCertificateBrowserLoadErrorCode(code: number | null | undefined): boolean {
  if (typeof code !== "number") return false;
  return code >= CERTIFICATE_LOAD_ERROR_CODE_MIN && code <= CERTIFICATE_LOAD_ERROR_CODE_MAX;
}

export function isAllowedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The system-default-browser entry accepts Web URLs and file URLs; do not reuse the broader local/inline protocol allowlist of the built-in browser. */
export function isDefaultBrowserOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

function hasAllowedExplicitProtocol(input: string): boolean {
  const protocol = input.match(URL_PROTOCOL_RE)?.[0].toLowerCase();
  return protocol ? ALLOWED_BROWSER_PROTOCOLS.has(protocol) : false;
}

function hasDisallowedExplicitProtocol(input: string): boolean {
  const match = input.match(URL_PROTOCOL_RE);
  if (!match) {
    return false;
  }

  const protocol = match[0].toLowerCase();
  if (ALLOWED_BROWSER_PROTOCOLS.has(protocol)) {
    return false;
  }

  return !/^\d{1,5}(?:$|[/?#])/.test(input.slice(match[0].length));
}

function parseSchemeLessUrl(input: string): URL | null {
  try {
    const normalizedInput = normalizeBareIpv6LoopbackInput(input);
    return new URL(
      normalizedInput.startsWith("//") ? `http:${normalizedInput}` : `http://${normalizedInput}`,
    );
  } catch {
    return null;
  }
}

function normalizeBareIpv6LoopbackInput(input: string): string {
  if (input === "::1") {
    return "[::1]";
  }

  if (/^::1(?=[:/?#])/.test(input)) {
    return `[::1]${input.slice(3)}`;
  }

  return input;
}

function getSchemeLessExplicitPort(input: string): string | null {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const withoutLeadingSlashes = normalizedInput.startsWith("//")
    ? normalizedInput.slice(2)
    : normalizedInput;
  const authority = withoutLeadingSlashes.split(/[/?#]/, 1)[0] ?? "";
  const hostWithPort = authority.split("@").at(-1) ?? authority;

  if (hostWithPort.startsWith("[")) {
    return hostWithPort.match(/^\[[^\]]+\]:(\d+)$/)?.[1] ?? null;
  }

  const portMatch = hostWithPort.match(/:(\d+)$/);
  if (!portMatch) {
    return null;
  }

  const host = hostWithPort.slice(0, portMatch.index);
  return host.includes(":") ? null : (portMatch[1] ?? null);
}

function parseIpv4Address(host: string): [number, number, number, number] | null {
  if (!IPV4_RE.test(host)) {
    return null;
  }

  const octets = host.split(".").map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost");
}

function isLocalDevelopmentHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (
    isLocalhostName(normalizedHost) ||
    normalizedHost === "::1" ||
    normalizedHost === "0:0:0:0:0:0:0:1" ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".test")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Address(normalizedHost);
  if (!ipv4) {
    return false;
  }

  const [first, second, third, fourth] = ipv4;
  return (
    first === 127 ||
    (first === 0 && second === 0 && third === 0 && fourth === 0) ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isLocalDevelopmentBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return isLocalDevelopmentHost(parsed.hostname);
  } catch {
    return false;
  }
}

type MessageLinkOpenTarget = "app-browser" | "external-browser";

/**
 * Interaction semantics: the two context-menu items explicitly choose complementary destinations; only a left click uses the local/private-network heuristic.
 * The menu's "Open" action previously reused the left-click default, sending both choices for public links (such as Feishu documents) to the system browser.
 */
export function resolveMessageLinkOpenTarget(input: {
  href: string;
  forceExternal?: boolean;
  forceInApp?: boolean;
}): MessageLinkOpenTarget {
  // If both flags are passed, forceExternal takes precedence to avoid an ambiguous combination.
  if (input.forceExternal) {
    return "external-browser";
  }

  if (input.forceInApp) {
    return "app-browser";
  }

  return isLocalDevelopmentBrowserUrl(input.href) ? "app-browser" : "external-browser";
}

function shouldPreferHttpForSchemeLessUrl(parsed: URL, explicitPort: string | null): boolean {
  if (isLocalDevelopmentHost(parsed.hostname)) {
    return true;
  }

  if (explicitPort && explicitPort !== "443") {
    return true;
  }

  return false;
}

function inferBrowserUrl(input: string): string {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const parsed = parseSchemeLessUrl(normalizedInput);
  const protocol =
    parsed && shouldPreferHttpForSchemeLessUrl(parsed, getSchemeLessExplicitPort(normalizedInput))
      ? "http"
      : "https";
  return normalizedInput.startsWith("//")
    ? `${protocol}:${normalizedInput}`
    : `${protocol}://${normalizedInput}`;
}

export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // The address bar previously prefixed every input without a scheme with https://, which prevented localhost,
  // 127.0.0.1, and common development ports from opening directly. Follow browser address-bar conventions and first recognize
  // localhost/private-network/port-qualified addresses and use HTTP by default; public domains still prefer HTTPS.
  if (hasDisallowedExplicitProtocol(trimmed)) {
    return null;
  }

  const url = hasAllowedExplicitProtocol(trimmed) ? trimmed : inferBrowserUrl(trimmed);
  return isAllowedBrowserUrl(url) ? url : null;
}

export function displayBrowserUrl(url: string): string {
  return url === DEFAULT_BROWSER_URL ? "" : url;
}
