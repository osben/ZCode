import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

export type OAuthCallbackOutcome = "success" | "denied" | "invalid" | "failed";
export type OAuthCallbackFlow = "sign-in" | "usage-link";
export type OAuthCallbackSurface = "app" | "cli";

export const DEFAULT_OAUTH_CALLBACK_APP_URL = "zcode://";

const MAX_DETAIL_LENGTH = 200;
const CUSTOM_SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*$/iu;
const FORBIDDEN_SCHEMES = new Set([
  "http",
  "https",
  "javascript",
  "data",
  "file",
  "vbscript",
  "blob",
]);

export interface OAuthCallbackPageOptions {
  readonly status: "success" | "error";
  readonly title: string;
  readonly message: string;
  /** Shown escaped and truncated; may come from the provider (`error_description`). */
  readonly detail?: string;
  /** Primary button; omitted when the URL is not a safe custom-scheme link. */
  readonly openApp?: { readonly label: string; readonly href: string };
  /** Secondary "Close tab" button label. */
  readonly closeLabel?: string;
  readonly footnote?: string;
}

export interface RenderedOAuthCallbackPage {
  readonly html: string;
  readonly contentSecurityPolicy: string;
}

export function isSafeAppUrl(href: string): boolean {
  if (!CUSTOM_SCHEME_URL.test(href)) return false;
  const scheme = href.slice(0, href.indexOf(":")).toLowerCase();
  return !FORBIDDEN_SCHEMES.has(scheme);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_DETAIL_LENGTH ? `${flat.slice(0, MAX_DETAIL_LENGTH - 1)}…` : flat;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1c1c1a;--muted:#6b6b66;--border:#e3e3de;--brand:#1c1c1a;--brand-fg:#fff;--ok:#1f8a4c;--ok-bg:#e4f4ea;--err:#c2362b;--err-bg:#fbe9e7}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#f1f1ee;--muted:#9a9a93;--border:#2e2e2b;--brand:#f1f1ee;--brand-fg:#141413;--ok:#4cc27d;--ok-bg:#16301f;--err:#f0766b;--err-bg:#3a1a17}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:400px;padding:36px 32px;background:var(--card);border:1px solid var(--border);border-radius:16px;text-align:center}
.icon{width:56px;height:56px;margin:0 auto 20px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.icon svg{width:28px;height:28px}
.success .icon{background:var(--ok-bg);color:var(--ok)}
.error .icon{background:var(--err-bg);color:var(--err)}
h1{margin:0 0 8px;font-size:20px;font-weight:600}
p{margin:0;color:var(--muted)}
.detail{margin-top:12px;font-size:13px;word-break:break-word}
.actions{margin-top:28px;display:flex;flex-direction:column;gap:10px}
.btn{display:block;padding:11px 16px;border-radius:10px;font:inherit;font-weight:500;text-decoration:none;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg)}
.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-fg)}
.btn:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.foot{margin-top:20px;font-size:12px}
`;

const ICON_SUCCESS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_ERROR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function renderOAuthCallbackPage(
  options: OAuthCallbackPageOptions,
): RenderedOAuthCallbackPage {
  const nonce = randomBytes(16).toString("base64");
  const safeOpen =
    options.openApp && isSafeAppUrl(options.openApp.href) ? options.openApp : undefined;
  const actions = [
    safeOpen
      ? `<a class="btn primary" id="open" href="${escapeHtml(safeOpen.href)}">${escapeHtml(safeOpen.label)}</a>`
      : "",
    options.closeLabel
      ? `<button class="btn" id="close" type="button">${escapeHtml(options.closeLabel)}</button>`
      : "",
  ].join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(options.title)}</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main class="${options.status}" role="${options.status === "error" ? "alert" : "status"}">
<div class="icon">${options.status === "success" ? ICON_SUCCESS : ICON_ERROR}</div>
<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.message)}</p>
${options.detail ? `<p class="detail">${escapeHtml(truncate(options.detail))}</p>` : ""}
${actions ? `<div class="actions">${actions}</div>` : ""}
${options.footnote ? `<p class="foot">${escapeHtml(options.footnote)}</p>` : ""}
</main>
<script nonce="${nonce}">
try{history.replaceState(null,"",location.pathname)}catch(e){}
var c=document.getElementById("close");if(c)c.addEventListener("click",function(){window.close();setTimeout(function(){c.textContent="You can close this tab now";c.disabled=true},200)});
</script></body></html>`;
  return {
    html,
    contentSecurityPolicy: `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

const FLOW_COPY: Record<OAuthCallbackFlow, { subject: string; success: string }> = {
  "sign-in": { subject: "Sign-in", success: "You're signed in" },
  "usage-link": { subject: "Usage linking", success: "Usage linked" },
};

export function buildOAuthCallbackPage(
  outcome: OAuthCallbackOutcome,
  context: {
    readonly flow: OAuthCallbackFlow;
    readonly surface: OAuthCallbackSurface;
    readonly appUrl?: string;
    readonly detail?: string;
  },
): OAuthCallbackPageOptions {
  const copy = FLOW_COPY[context.flow];
  const returnHint =
    context.surface === "app"
      ? "Return to ZCode to continue."
      : "Return to your terminal to continue.";
  const app =
    context.surface === "app"
      ? { label: "Open ZCode", href: context.appUrl ?? DEFAULT_OAUTH_CALLBACK_APP_URL }
      : undefined;
  const detail = context.detail ? { detail: context.detail } : {};
  switch (outcome) {
    case "success":
      return {
        status: "success",
        title: copy.success,
        message: `${copy.subject} complete. ${returnHint}`,
        ...(app ? { openApp: app } : {}),
        closeLabel: "Close this tab",
      };
    case "denied":
      return {
        status: "error",
        title: `${copy.subject} was cancelled`,
        message: `Access was not granted. You can start again from ${context.surface === "app" ? "ZCode" : "the terminal"}.`,
        ...detail,
        ...(app ? { openApp: app } : {}),
      };
    case "invalid":
      return {
        status: "error",
        title: "This link is no longer valid",
        message: `It may be outdated or from another attempt. Start ${copy.subject.toLowerCase()} again from ${context.surface === "app" ? "ZCode" : "the terminal"}.`,
        ...(app ? { openApp: app } : {}),
      };
    case "failed":
      return {
        status: "error",
        title: `${copy.subject} failed`,
        message: `Something went wrong while finishing ${copy.subject.toLowerCase()}. Please try again.`,
        ...detail,
        ...(app ? { openApp: app } : {}),
      };
  }
}

export function respondWithOAuthCallbackPage(
  response: ServerResponse,
  httpStatus: number,
  options: OAuthCallbackPageOptions,
): void {
  const { html, contentSecurityPolicy } = renderOAuthCallbackPage(options);
  response.writeHead(httpStatus, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicy,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}
