import type { GlobalNoticeEnvelope } from "@/global-notice/globalNoticeStore.js";
import type { HighspeedShareMetrics } from "@/highspeed/highspeedTurnStore.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";

export const HIGHSPEED_NOTICE_DISMISS_COOLDOWN_MS = 24 * 60 * 60_000;
export const HIGHSPEED_NOTICE_AUTO_CLOSE_MS = 24 * 60 * 60_000;
export const MIN_HIGHSPEED_SHARE_SPEEDUP = 1.2;
/**
 * Payload of the bottom-left share-card notice. Metrics are always carried as millisecond facts
 * (same precision as the publish gate isHighspeedShareEligible); second-based display values are
 * derived on the render side; durationSeconds/savedDurationSeconds are compatibility read-only
 * fields only for legacy persisted notices within 24h.
 */
export interface HighspeedShareNoticePayload extends Record<string, unknown> {
  cardId: string;
  tokenUsage: number;
  durationMs?: number;
  savedDurationMs?: number;
  /** @deprecated Legacy second-rounded field, kept read-only for compatibility; no longer written. */
  durationSeconds?: number;
  /** @deprecated Legacy second-rounded field, kept read-only for compatibility; no longer written. */
  savedDurationSeconds?: number;
}

export async function copyHighspeedShareText(
  text: string,
  writeText: (value: string) => Promise<void> = async (value) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("text clipboard is unavailable");
    }
    await navigator.clipboard.writeText(value);
  },
): Promise<void> {
  await writeText(text);
}

/** Compact duration: minutes for >=60s, otherwise seconds; shared by the speedup label and the exported image, keeping compact units consistent across languages. */
export function formatHighspeedDurationShort(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}min`;
  return `${totalSeconds}s`;
}

function resolveHighspeedSavedDurationMs(metrics: HighspeedShareMetrics): number {
  return metrics.savedDurationMs ?? calculateHighspeedSavedDurationMs(metrics);
}

/**
 * The share entry is open only to complete, trustworthy card-level data, so low-benefit or
 * duration-less results do not generate misleading share cards. Uses the unrounded speedup so the
 * 1.2x boundary stays stable and display-side formatting cannot affect eligibility.
 */
export function isHighspeedShareEligible(metrics: HighspeedShareMetrics): boolean {
  if (
    !Number.isFinite(metrics.outputTokens) ||
    metrics.outputTokens <= 0 ||
    !Number.isFinite(metrics.durationMs) ||
    metrics.durationMs <= 0 ||
    !Number.isFinite(metrics.regularTps) ||
    metrics.regularTps <= 0 ||
    !Number.isFinite(metrics.highspeedTps) ||
    metrics.highspeedTps <= 0
  ) {
    return false;
  }
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  if (!Number.isFinite(savedDurationMs) || savedDurationMs < 0) return false;
  const overallSpeedup = (metrics.durationMs + savedDurationMs) / metrics.durationMs;
  return Number.isFinite(overallSpeedup) && overallSpeedup > MIN_HIGHSPEED_SHARE_SPEEDUP;
}

/** Prefers the CLI's real durations; legacy messages fall back to the tools 20% / model 80% estimate. */
export function highspeedSpeedup(metrics: HighspeedShareMetrics): number {
  const durationMs = Math.max(metrics.durationMs, 1);
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  return Math.max(0, Math.round(((durationMs + savedDurationMs) / durationMs) * 10) / 10);
}

/** Time-saved percentage, computed from the real breakdown or the compatible 20/80 fallback. */
export function highspeedSavedPercent(metrics: HighspeedShareMetrics): number {
  const durationMs = Math.max(metrics.durationMs, 0);
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  const regularDurationMs = durationMs + savedDurationMs;
  if (regularDurationMs <= 0) return 0;
  return Math.max(0, Math.min(99, Math.round((savedDurationMs / regularDurationMs) * 100)));
}

const HIGHSPEED_CARD_IMAGE_SIZE = { width: 436, height: 304 } as const;

export interface HighspeedShareImageLabels {
  benefit: string;
  standardSpeed: string;
  speedSummary: string;
  lessWaiting: string;
  imageSummary: string;
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&apos;",
        '"': "&quot;",
      })[character] ?? character,
  );
}

/** Consistent with useTheme's applyTheme: dark when the root element has the dark class; defaults to the dark brand card when there is no DOM. */
function detectHighspeedCardDarkTheme(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement?.classList?.contains("dark") ?? true;
}

/** Renders the stats section as a standalone SVG so copying the image does not include the dialog's bottom copy and buttons. */
export async function copyHighspeedCardImage(
  metrics: HighspeedShareMetrics,
  writeImage: (blob: Blob) => Promise<void> = async (blob) => {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof ClipboardItem === "undefined"
    ) {
      throw new Error("image clipboard is unavailable");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  },
  labels?: HighspeedShareImageLabels,
): Promise<void> {
  const savedSeconds = Math.max(0, Math.round(resolveHighspeedSavedDurationMs(metrics) / 1_000));
  const speedup = highspeedSpeedup(metrics);
  const savedPercent = highspeedSavedPercent(metrics);
  const imageLabels: HighspeedShareImageLabels = labels ?? {
    benefit: "ZCode & Coding Plan Exclusive Benefits",
    standardSpeed: "standard generation speed",
    speedSummary: `HighSpeed · ${formatHighspeedDurationShort(metrics.durationMs)}`,
    lessWaiting: `${savedPercent}% less waiting`,
    imageSummary: `${Math.floor(metrics.outputTokens).toLocaleString()} tokens · ${savedSeconds}s saved`,
  };
  const { width, height } = HIGHSPEED_CARD_IMAGE_SIZE;
  const fontStack = "Geist,-apple-system,'Segoe UI',Arial,sans-serif";
  // Dark and light modes map to the design mock's dark/light palette variants respectively.
  const dark = detectHighspeedCardDarkTheme();
  const palette = dark
    ? {
        bg: "#101010",
        cardStroke: "",
        titleText: "#acacac",
        tagStroke: "rgba(255,255,255,0.16)",
        tagFillTop: "rgba(255,255,255,0.06)",
        tagFillBottom: "rgba(153,153,153,0.06)",
        title: "#ffffff",
        subtitle: "#b1b1b1",
        divider: "#ffffff",
        summary: "#8f8f8f",
        track: "#2b2b2b",
      }
    : {
        bg: "#ffffff",
        cardStroke: ` stroke="#0d0d0d" stroke-opacity="0.1"`,
        titleText: "#5c5c5c",
        tagStroke: "rgba(0,0,0,0.16)",
        tagFillTop: "rgba(0,0,0,0.06)",
        tagFillBottom: "rgba(0,0,0,0.04)",
        title: "#0d0d0d",
        subtitle: "#5c5c5c",
        divider: "#0d0d0d",
        summary: "#5c5c5c",
        track: "rgba(0,0,0,0.08)",
      };
  // The copied image matches the dialog: a full dark track plus a three-stop gradient filled to the
  // "relative duration" ratio, with the landing point marked by a thin green marker.
  const meterX = 24;
  const meterY = 186;
  const meterW = width - meterX * 2;
  const meterH = 8;
  const fillW = Math.max(0, meterW * Math.max(0, Math.min(1, (100 - savedPercent) / 100)));
  const markerX = meterX + fillW;
  const meter = `<rect x="${meterX}" y="${meterY}" width="${meterW}" height="${meterH}" rx="1" fill="${palette.track}"/><rect x="${meterX}" y="${meterY}" width="${fillW.toFixed(2)}" height="${meterH}" rx="1" fill="url(#hs-meter)"/><rect x="${(markerX - 1).toFixed(2)}" y="${meterY - 6}" width="2" height="20" rx="1" fill="#01c34b"/>`;
  // Title row matches the dialog (Figma 6403:11193): Z logo tile + benefit copy + HighSpeed pill; the logo is a vector approximation.
  const titleRow = `<rect x="24" y="27" width="16" height="16" rx="3.2" fill="#2d2d2d" stroke="rgba(255,255,255,0.12)" stroke-width="0.53"/><text x="32" y="39" text-anchor="middle" fill="#ffffff" font-family="${fontStack}" font-size="11" font-weight="700">Z</text><text x="48" y="39" fill="${palette.titleText}" font-family="${fontStack}" font-size="12">${escapeXml(imageLabels.benefit)}</text><rect x="286" y="25.5" width="69" height="19" rx="9.5" fill="url(#hs-tag)" stroke="${palette.tagStroke}" stroke-width="0.4"/><text x="320.5" y="38" text-anchor="middle" fill="${palette.titleText}" font-family="${fontStack}" font-size="11">HighSpeed</text>`;
  const defs = `<defs><linearGradient id="hs-tag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.tagFillTop}"/><stop offset="1" stop-color="${palette.tagFillBottom}"/></linearGradient><linearGradient id="hs-meter" x1="${meterX}" y1="0" x2="${markerX.toFixed(2)}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e05048"/><stop offset="0.52" stop-color="#e8b348"/><stop offset="1" stop-color="#34b769"/></linearGradient></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<rect width="${width}" height="${height}" fill="${palette.bg}"${palette.cardStroke}/>${titleRow}<text x="32" y="118" fill="${palette.title}" font-family="${fontStack}"><tspan font-size="52" font-weight="500" letter-spacing="-1">${speedup}</tspan><tspan font-size="24" font-weight="500">x</tspan><tspan dx="8" font-size="12" font-weight="300" fill="${palette.subtitle}">${escapeXml(imageLabels.standardSpeed)}</tspan></text><line x1="24" y1="140" x2="412" y2="140" stroke="${palette.divider}" stroke-opacity="0.1"/><path d="M28.7 154 24.6 160.5h3l-1.5 6.5 8-8h-4l1.5-5z" fill="#00a640"/><text x="44" y="165" fill="#00a640" font-family="${fontStack}" font-size="13" font-weight="500">${escapeXml(imageLabels.speedSummary)}</text><text x="412" y="164" text-anchor="end" fill="#00a640" font-family="${fontStack}" font-size="11" font-weight="500">${escapeXml(imageLabels.lessWaiting)}</text>${meter}<text x="24" y="270" fill="${palette.summary}" font-family="${fontStack}" font-size="12">${escapeXml(imageLabels.imageSummary)}</text></svg>`;
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  // Chromium's image clipboard does not accept image/svg+xml; desktop must rasterize to PNG first.
  if (
    typeof Image === "undefined" ||
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    !URL.createObjectURL
  ) {
    await writeImage(svgBlob);
    return;
  }
  const image = new Image();
  // Bug root cause: a second rounded-corner clip was previously applied on the canvas — the SVG
  // bitmap edge (blurry after scaling) and the vector clip edge (sharp) overlapped at the corners,
  // leaving faint misaligned arc artifacts even when geometrically aligned. The rounded transparent
  // corners come from the SVG rect's rx; the correct approach is to let the browser rasterize the
  // SVG directly at the export size (vector supersampling, viewBox keeps logical coordinates),
  // place it 1:1 with drawImage, and do no secondary clipping on the canvas.
  const exportScale = Math.max(
    2,
    Math.ceil(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
  );
  const objectUrl = URL.createObjectURL(
    new Blob(
      [
        svg.replace(
          `width="${width}" height="${height}" viewBox=`,
          `width="${width * exportScale}" height="${height * exportScale}" viewBox=`,
        ),
      ],
      { type: "image/svg+xml" },
    ),
  );
  try {
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = HIGHSPEED_CARD_IMAGE_SIZE.width * exportScale;
        canvas.height = HIGHSPEED_CARD_IMAGE_SIZE.height * exportScale;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("canvas context unavailable"));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("canvas export failed"))),
          "image/png",
        );
      };
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = objectUrl;
    });
    await writeImage(pngBlob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function buildHighspeedShareNotice(params: {
  cardId: string;
  metrics: HighspeedShareMetrics;
  now?: number;
}): GlobalNoticeEnvelope {
  const now = params.now ?? Date.now();
  // The share card shows the full Turn's actual working duration; saved time prefers the CLI-
  // persisted highspeed model duration, so regular-provider fallback/retry time never enters the
  // Highspeed saving calculation.
  // Bug root cause: only second-level fields ceil(duration)/round(saved) were written, and the
  // render side rebuilt the speedup from seconds, systematically underestimating in the
  // (1.2, ~1.25] boundary band (6100ms/1225ms is really 1.2008x → 8/7≈1.14x) and hiding View.
  // The millisecond values used by the publish gate are carried verbatim with no rounding, so the
  // render-side recheck can never disagree with the gate (spec §9).
  const payload: HighspeedShareNoticePayload = {
    cardId: params.cardId,
    tokenUsage: Math.max(0, Math.floor(params.metrics.outputTokens)),
    durationMs: Math.max(0, params.metrics.durationMs),
    savedDurationMs: Math.max(0, resolveHighspeedSavedDurationMs(params.metrics)),
  };
  return {
    noticeId: `highspeed-share:${params.cardId}:${now}`,
    dedupeKey: "highspeed-share:latest",
    type: "highspeed-share",
    schemaVersion: 1,
    scope: "user",
    priority: "normal",
    interruptPolicy: "passive",
    createdAt: now,
    expiresAt: now + HIGHSPEED_NOTICE_AUTO_CLOSE_MS,
    payload,
    actions: [],
    dismissPolicy: { kind: "cooldown", cooldownMs: HIGHSPEED_NOTICE_DISMISS_COOLDOWN_MS },
    persistencePolicy: "latest-only",
    source: "highspeed",
    revision: now,
  };
}

export function isHighspeedShareNoticePayload(
  payload: Record<string, unknown>,
): payload is HighspeedShareNoticePayload {
  return (
    typeof payload.cardId === "string" &&
    typeof payload.tokenUsage === "number" &&
    (typeof payload.durationMs === "number" || typeof payload.durationSeconds === "number")
  );
}

/**
 * Restores share metrics from the notice payload: millisecond fields take priority (same precision
 * as the publish gate, so the recheck always agrees); legacy second-level payloads fall back to
 * x1000. TPS is synthesized only to satisfy isHighspeedShareEligible's positive check; the speedup
 * and saved percent are computed entirely from durationMs + savedDurationMs and do not depend on
 * the synthesized TPS.
 */
export function resolveHighspeedShareNoticeMetrics(
  payload: HighspeedShareNoticePayload,
): HighspeedShareMetrics {
  const durationMs = payload.durationMs ?? (payload.durationSeconds ?? 0) * 1_000;
  const savedDurationMs = payload.savedDurationMs ?? (payload.savedDurationSeconds ?? 0) * 1_000;
  return {
    outputTokens: payload.tokenUsage,
    durationMs,
    regularTps: Math.max(
      1,
      payload.tokenUsage / Math.max((durationMs + savedDurationMs) / 1_000, 1),
    ),
    highspeedTps: Math.max(1, payload.tokenUsage / Math.max(durationMs / 1_000, 1)),
    savedDurationMs,
  };
}
