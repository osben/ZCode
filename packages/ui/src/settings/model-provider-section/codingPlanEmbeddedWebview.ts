import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  isTrustedCodingPlanWebviewOrigin,
  isZaiCodingPlanProviderId,
  normalizeZCodeEndpointOrigin,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import type { CodingPlanWebviewLocale } from "@zcode/shared";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

type CodingPlanWebsiteProvider = "zai" | "bigmodel";
export type CodingPlanPurchaseAudience = "personal" | "team";

export interface CodingPlanEmbeddedCredentials {
  zaiAccessToken?: string | null;
  zcodeJwtToken?: string | null;
  bigmodelAccessToken?: string | null;
}

interface CodingPlanEmbeddedReportContext {
  purchase_funnel_id?: string;
  purchase_entry_reporter?: "app";
  upgrade_source?: string;
  event_region?: string;
  event_text?: string;
  entry_plan_status?: string;
  entry_plan_level?: string;
  entry_plan_list?: string;
  purchase_audience?: string;
  provider_family?: string;
  channel?: string;
  device_mid?: string;
  user_id?: string;
  app_version?: string;
}

export type CodingPlanEmbeddedTheme = "zai-light" | "zai-dark";

/**
 * App locale (zh-CN / en-US) → website URL lang segment (cn / en).
 * Used as a `?lang=` hint in the webview URL so the site starts in the correct language and does not flash English before injection.
 */
function codingPlanLocaleToWebsiteLang(
  locale: CodingPlanWebviewLocale | null | undefined,
): "cn" | "en" {
  return locale === "zh-CN" ? "cn" : "en";
}

interface ResolveCodingPlanEmbeddedOriginOptions {
  endpointOrigin: string;
  e2eStoreBridgeEnabled?: boolean;
  overrideOrigin?: string | null;
}

export const CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY = "VITE_CODING_PLAN_WEBVIEW_ORIGIN";
const CODING_PLAN_WEBVIEW_CREDENTIAL_LOCAL_STORAGE_KEYS = [
  "oauth:zai:access_token",
  "zcodejwttoken",
  "oauth:bigmodel:access_token",
] as const;
const CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY = "zcode:coding-plan:report-context";

export function resolveCodingPlanWebsiteProvider(
  providerId: CodingPlanProviderId,
): CodingPlanWebsiteProvider {
  return isZaiCodingPlanProviderId(providerId) ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    ? "zai"
    : "bigmodel";
}

export function resolveCodingPlanEmbeddedOrigin({
  endpointOrigin,
  e2eStoreBridgeEnabled,
  overrideOrigin,
}: ResolveCodingPlanEmbeddedOriginOptions): string {
  const normalizedOverride = overrideOrigin?.trim();
  if (
    normalizedOverride &&
    isTrustedCodingPlanWebviewOrigin(normalizedOverride, { e2eStoreBridgeEnabled })
  ) {
    return normalizeZCodeEndpointOrigin(normalizedOverride);
  }
  const normalizedEndpointOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  return isTrustedCodingPlanWebviewOrigin(normalizedEndpointOrigin, { e2eStoreBridgeEnabled })
    ? normalizedEndpointOrigin
    : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
}

export function buildCodingPlanEmbeddedWebviewUrl({
  origin,
  provider,
  locale,
  theme,
  audience,
  teamPlanKey,
}: {
  origin: string;
  provider: CodingPlanWebsiteProvider;
  // Pass the current App locale as the website's initial language hint (?lang=cn|en) to prevent an English flash before injection.
  locale?: CodingPlanWebviewLocale | null;
  // The site defaults to dark in SSR, and localStorage has no theme when the WebView first opens.
  // Put the current App theme in the URL so the site's head script can read it before the first paint.
  theme?: CodingPlanEmbeddedTheme | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
}): string {
  const url = new URL("/coding-plan", normalizeZCodeEndpointOrigin(origin));
  url.searchParams.set("provider", provider);
  url.searchParams.set("embedded", "app");
  url.searchParams.set("lang", codingPlanLocaleToWebsiteLang(locale));
  if (audience) {
    url.searchParams.set("audience", audience);
  }
  if (teamPlanKey?.trim()) {
    url.searchParams.set("teamPlanKey", teamPlanKey.trim());
  }
  if (theme) {
    url.searchParams.set("theme", theme);
  }
  return url.toString();
}

export function isTrustedCodingPlanEmbeddedWebviewUrl(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: options?.e2eStoreBridgeEnabled,
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    if (url.searchParams.get("embedded") === "app") return true;
    // After PayPal succeeds, it first returns to /coding-plan/payment/callback, with embedded=app
    // in returnTo. That page still needs the App-injected OAuth token to finish subscribe, so do not treat it as an external site and clear credentials.
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

export function createCodingPlanAuthInjectionScript({
  provider,
  credentials,
  theme,
  locale,
  reportContext,
}: {
  provider: CodingPlanWebsiteProvider;
  credentials: CodingPlanEmbeddedCredentials;
  theme: CodingPlanEmbeddedTheme;
  // Write the current App locale to window.__zcodeLang__ for zcodeBridge.getLang(),
  // and include it in auth-ready event detail so the site can sync its initial language once.
  locale: CodingPlanWebviewLocale | null;
  reportContext?: CodingPlanEmbeddedReportContext | null;
}): string {
  const values: Record<string, string | null> =
    provider === "zai"
      ? {
          "oauth:zai:access_token": credentials.zaiAccessToken?.trim() || null,
          zcodejwttoken: credentials.zcodeJwtToken?.trim() || null,
          "oauth:bigmodel:access_token": null,
        }
      : {
          "oauth:zai:access_token": null,
          // zcodejwttoken is a general credential for the zcode-plan domain (the BigModel OAuth callback also persists it).
          // The site uses it to query billing/balance and determine whether Start Plan is active; omitting it in the BigModel branch
          // makes the site show the Start Plan card as expired because it cannot find entitlements. Business APIs still use
          // oauth:bigmodel:access_token; the two credentials remain separate.
          zcodejwttoken: credentials.zcodeJwtToken?.trim() || null,
          "oauth:bigmodel:access_token": credentials.bigmodelAccessToken?.trim() || null,
        };
  const storageUpdates = Object.entries(values)
    .map(([key, value]) =>
      value
        ? `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`
        : `localStorage.removeItem(${JSON.stringify(key)});`,
    )
    .join("\n  ");
  const resolvedLocale: CodingPlanWebviewLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  const normalizedReportContext = normalizeCodingPlanEmbeddedReportContext(reportContext);

  return `(() => {
  ${storageUpdates}
  const zcodeTheme = ${JSON.stringify(theme)};
  document.documentElement.classList.toggle("dark", zcodeTheme === "zai-dark");
  document.documentElement.classList.toggle("theme-zai-light", zcodeTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", zcodeTheme === "zai-dark");
  localStorage.setItem("zcode-theme", zcodeTheme);
  localStorage.setItem("zcode:coding-plan:embedded", "app");
  // Write the current App locale for the website's zcodeBridge.getLang().
  // This is raw JS injected into the webview, so do not use TypeScript syntax such as type assertions.
  window.__zcodeLang__ = ${JSON.stringify(resolvedLocale)};
  const zcodeReportContext = ${JSON.stringify(normalizedReportContext)};
  window.__zcodeReportContext__ = zcodeReportContext;
  localStorage.setItem(${JSON.stringify(CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY)}, JSON.stringify(zcodeReportContext));
  window.dispatchEvent(new CustomEvent("zcode-coding-plan-auth-ready", {
    detail: { ...${JSON.stringify({ provider, locale: resolvedLocale })}, reportContext: zcodeReportContext },
  }));
})()`;
}

export function buildCodingPlanEmbeddedReportContext({
  funnelContext,
  deviceMid,
  userId,
  appVersion,
}: {
  funnelContext?: CodingPlanFunnelContext | null;
  deviceMid?: string | null;
  userId?: string | null;
  appVersion?: string | null;
}): CodingPlanEmbeddedReportContext {
  return normalizeCodingPlanEmbeddedReportContext({
    purchase_funnel_id: funnelContext?.purchaseFunnelId,
    // Without an ownership marker, the compatibility site may report the entry point again; do not claim App ownership when there is no funnel.
    purchase_entry_reporter: funnelContext ? "app" : undefined,
    upgrade_source: funnelContext?.upgradeSource,
    event_region: funnelContext?.eventRegion,
    event_text: funnelContext?.eventText,
    entry_plan_status: funnelContext?.entryPlanStatus,
    entry_plan_level: funnelContext?.entryPlanLevel,
    entry_plan_list: funnelContext?.entryPlanList,
    purchase_audience: funnelContext?.purchaseAudience,
    provider_family: funnelContext?.providerFamily,
    channel: funnelContext?.channel,
    device_mid: deviceMid ?? undefined,
    user_id: userId ?? undefined,
    app_version: appVersion ?? undefined,
  });
}

function normalizeCodingPlanEmbeddedReportContext(
  context: CodingPlanEmbeddedReportContext | null | undefined,
): CodingPlanEmbeddedReportContext {
  if (!context) return {};
  return Object.fromEntries(
    Object.entries(context).flatMap(([key, value]) => {
      if (typeof value !== "string") return [];
      const normalized = value.trim();
      return normalized ? [[key, normalized]] : [];
    }),
  ) as CodingPlanEmbeddedReportContext;
}

export function createCodingPlanCredentialClearScript(): string {
  const keys = [...CODING_PLAN_WEBVIEW_CREDENTIAL_LOCAL_STORAGE_KEYS];
  return `(() => {
  for (const key of ${JSON.stringify(keys)}) {
    localStorage.removeItem(key);
  }
  localStorage.removeItem(${JSON.stringify(CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY)});
  delete window.__zcodeReportContext__;
})()`;
}

export function createCodingPlanScrollbarHideScript(): string {
  return `(() => {
  const styleId = "zcode-coding-plan-hide-scrollbar";
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = \`
html,
body,
* {
  scrollbar-width: none !important;
}

html::-webkit-scrollbar,
body::-webkit-scrollbar,
*::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
\`;
  document.head.appendChild(style);
})()`;
}

/**
 * Generates the injected script that updates the webview's current locale.
 * When App locale changes at runtime, execute this script in the webview:
 * rewrite window.__zcodeLang__ and dispatch the zcode-coding-plan-lang-change event,
 * allowing the site (zcodeBridge.onLangChange or a window listener) to switch language without a reload.
 */
export function createCodingPlanLangInjectionScript(locale: CodingPlanWebviewLocale): string {
  const resolvedLocale: CodingPlanWebviewLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return `(() => {
   // This is raw JS injected into the webview, so do not use TypeScript syntax such as type assertions.
  window.__zcodeLang__ = ${JSON.stringify(resolvedLocale)};
  window.dispatchEvent(new CustomEvent("zcode-coding-plan-lang-change", {
    detail: ${JSON.stringify({ locale: resolvedLocale })},
  }));
})()`;
}

export function getCodingPlanCredentialKeys(provider: CodingPlanWebsiteProvider): string[] {
  // Load zcodejwttoken for both providers: it is a general credential for the zcode-plan domain,
  // and the BigModel OAuth callback persists it too (see resolveBigModelStartPlanZcodeJwt).
  return provider === "zai"
    ? [`oauth:${ZAI_PROVIDER_ID}:access_token`, "zcodejwttoken"]
    : [`oauth:${BIGMODEL_PROVIDER_ID}:access_token`, "zcodejwttoken"];
}
