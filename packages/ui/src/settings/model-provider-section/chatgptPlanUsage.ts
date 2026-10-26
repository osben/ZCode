/**
 * Pure presentation rules for ChatGPT plan usage windows (specs/chatgpt-plan-signin.md "Usage display (Settings)").
 * They hold no state: the host owns the snapshot, the detail owns the clock tick.
 */
import type { SiwcPlanUsageSnapshot, SiwcPlanUsageWindow } from "@zcode/shared";

export const USAGE_STALE_AFTER_MS = 5 * 60_000;
export const USAGE_WARNING_PERCENT = 70;
export const USAGE_CRITICAL_PERCENT = 90;

export type UsageSeverity = "normal" | "warning" | "critical";

export type UsageWindowRole = "primary" | "secondary";

/** An intl message id with its values. */
export interface UsageMessage {
  readonly id: string;
  readonly values?: Record<string, string | number>;
}

const PREFIX = "settings.modelProvider.chatgpt.usage";

export function usageWindowLabel(
  window: Pick<SiwcPlanUsageWindow, "windowMinutes">,
  role: UsageWindowRole,
): UsageMessage {
  const minutes = window.windowMinutes;
  if (minutes === undefined) {
    return { id: `${PREFIX}.window.${role === "primary" ? "fiveHour" : "weekly"}` };
  }
  if (minutes === 300) return { id: `${PREFIX}.window.fiveHour` };
  if (minutes === 10_080) return { id: `${PREFIX}.window.weekly` };
  if (minutes % 1440 === 0) return { id: `${PREFIX}.window.days`, values: { n: minutes / 1440 } };
  return { id: `${PREFIX}.window.hours`, values: { n: Math.max(1, Math.round(minutes / 60)) } };
}

export function usageRemainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

export function usageSeverity(usedPercent: number, limitReached = false): UsageSeverity {
  if (limitReached || usedPercent >= USAGE_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= USAGE_WARNING_PERCENT) return "warning";
  return "normal";
}

/**
 * "Resets in" duration: rounded up to whole minutes, at most two units. Null when the reset time is unknown;
 * `pending` once it has passed (the snapshot is older than the reset).
 */
export function usageResetCountdown(
  resetsAt: string | undefined,
  nowMs: number,
): UsageMessage | "pending" | null {
  const resetMs = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(resetMs)) return null;
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return "pending";
  if (remainingMs < 60_000) return { id: `${PREFIX}.duration.underMinute` };
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0
      ? { id: `${PREFIX}.duration.dh`, values: { d: days, h: hours } }
      : { id: `${PREFIX}.duration.d`, values: { d: days } };
  }
  if (hours > 0) {
    return minutes > 0
      ? { id: `${PREFIX}.duration.hm`, values: { h: hours, m: minutes } }
      : { id: `${PREFIX}.duration.h`, values: { h: hours } };
  }
  return { id: `${PREFIX}.duration.m`, values: { m: minutes } };
}

/** Absolute reset time for the tooltip; the weekday is added when the reset is not today. */
export function usageResetAbsolute(resetsAt: string, nowMs: number, locale: string): string | null {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const sameDay = new Date(resetMs).toDateString() === new Date(nowMs).toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(resetMs);
}

/** Minutes since the snapshot was stored, or null while it is fresh (or the capture time is unknown). */
export function usageStaleMinutes(
  snapshot: Pick<SiwcPlanUsageSnapshot, "capturedAt">,
  nowMs: number,
): number | null {
  const capturedMs = Date.parse(snapshot.capturedAt ?? "");
  if (!Number.isFinite(capturedMs)) return null;
  const ageMs = nowMs - capturedMs;
  return ageMs >= USAGE_STALE_AFTER_MS ? Math.floor(ageMs / 60_000) : null;
}

const KNOWN_PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

export function usagePlanLabel(planType: string | undefined): string | null {
  const trimmed = planType?.trim();
  if (!trimmed) return null;
  return KNOWN_PLAN_LABELS[trimmed.toLowerCase()] ?? trimmed;
}
