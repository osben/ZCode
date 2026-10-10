import type {
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  UsageQuotaLimit,
} from "@zcode/shared";
// How long to show the "quota reset" message before hiding it automatically (the quota bar remains at 100%).
export const CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS = 2_600;
// For automatic/operational resets, briefly synthesize a "resetting" state on the Composer trigger, then switch to "reset".
// The backend has no processing signal; this only recreates the "processing → reset" transition in the client.
export const CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS = 1_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// Optimistically update the "next reset" interval after completion: 5 hours for the five-hour quota and 7 days for the weekly quota.
function resolveCodingPlanQuotaResetDurationMs(resetType: CodingPlanResetType): number {
  return resetType === "WEEK" ? WEEK_MS : FIVE_HOURS_MS;
}

// available: the server returned a usable five-hour reset opportunity.
// processing: the user started a manual redemption; waiting to reconcile use + status.
// completed: status returned the server's used_at; automatic/operational resets do not pass through processing.
export type CodingPlanQuotaResetUiStatus = "available" | "processing" | "completed";

export interface CodingPlanQuotaResetUiEntry {
  status: CodingPlanQuotaResetUiStatus;
  /** Number of reset opportunities remaining; zero in processing/completed states. */
  opportunityCount: number;
  /** Earliest expiration time among reset opportunities; valid only while available. */
  opportunityExpiresAt: number | null;
  /** Local start time for manual redemption; null for automatic/operational resets. */
  startedAt: number | null;
  /** Server's latest_{five_hour,week}_reset_history.used_at. */
  completedAt: number | null;
  /** When the client first observed the current completedAt; used only for the brief message and animation. */
  observedAt: number | null;
  /** Temporarily allow the quota to be shown as 100% until entitlement refresh succeeds. */
  quotaOverridePending: boolean;
  nextResetAt: number | null;
  /** Idempotency key reused by retries of the same failed request; cleared after successful reconciliation. */
  idempotencyKey: string | null;
  error: string | null;
}

export interface CodingPlanQuotaResetCelebrationState {
  sourceKey: string | null;
  /** The trigger already played confetti for this used_at; do not replay it on repeated renders or polling. */
  celebratedCompletedAt: number | null;
}

/** Independent reset state for the five-hour and weekly quotas under the same source. */
export interface CodingPlanQuotaResetUiEntries {
  fiveHour: CodingPlanQuotaResetUiEntry | null;
  week: CodingPlanQuotaResetUiEntry | null;
}

/** The five-hour and weekly quotas share one reset state machine; type only distinguishes which opportunity/history fields to read. */
export const CODING_PLAN_QUOTA_RESET_TYPES = [
  "FIVE_HOUR",
  "WEEK",
] as const satisfies readonly CodingPlanResetType[];

export function advanceCodingPlanQuotaResetCelebration(
  previous: CodingPlanQuotaResetCelebrationState | null,
  input: {
    sourceKey: string | null;
    completedAt: number | null;
    /** Brief message window for automatic/operational completion (startedAt is null); manual reset confetti comes from the button, not the trigger. */
    automaticCompletion: boolean;
  },
): {
  state: CodingPlanQuotaResetCelebrationState;
  shouldCelebrate: boolean;
} {
  // Manual redemption also passes through processing, so "saw processing" cannot be used as the trigger's confetti condition,
  // otherwise manual reset would animate both on the button and trigger. The trigger only recognizes a new used_at from automatic completion,
  // and clears the trail when source changes to avoid duplicate confetti or missed automatic-reset animation between Team and personal plans.
  const sourceChanged = previous?.sourceKey !== input.sourceKey;
  const celebratedCompletedAt = sourceChanged ? null : (previous?.celebratedCompletedAt ?? null);
  const shouldCelebrate = Boolean(
    input.sourceKey &&
    input.automaticCompletion &&
    input.completedAt !== null &&
    input.completedAt !== celebratedCompletedAt,
  );

  return {
    state: {
      sourceKey: input.sourceKey,
      celebratedCompletedAt: shouldCelebrate ? input.completedAt : celebratedCompletedAt,
    },
    shouldCelebrate,
  };
}

function createAvailableEntry(
  opportunityCount: number,
  opportunityExpiresAt: number,
  idempotencyKey: string | null,
): CodingPlanQuotaResetUiEntry {
  return {
    status: "available",
    opportunityCount,
    opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey,
    error: null,
  };
}

function createCompletedEntry(
  previous: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
  observedAt: number,
  manualStartedAt: number | null,
  nextResetMs: number,
): CodingPlanQuotaResetUiEntry {
  const isSameCompletion = previous?.status === "completed" && previous.completedAt === completedAt;
  return {
    status: "completed",
    opportunityCount: 0,
    opportunityExpiresAt: null,
    // A manual click and completion history may be observed through different entry points. Relying only on processing for the current source
    // would make Composer misclassify a manual reset started on the settings page as automatic, showing the tooltip and confetti twice.
    // Reconciliation of the same completion history must preserve its original classification; a later poll must not reclassify it as automatic.
    startedAt: isSameCompletion
      ? previous.startedAt
      : previous?.status === "processing"
        ? previous.startedAt
        : manualStartedAt,
    completedAt,
    // Polling may discover an automatic/operational reset up to 60 seconds after used_at.
    // Start the brief message at first observation; repeated polls of the same used_at must not extend it.
    observedAt: isSameCompletion ? (previous.observedAt ?? observedAt) : observedAt,
    quotaOverridePending: isSameCompletion ? previous.quotaOverridePending : true,
    nextResetAt: completedAt + nextResetMs,
    idempotencyKey: null,
    error: null,
  };
}

/** Apply server status to shared UI state within this window. Old history with has_unread_history=false must not enter completed on initial mount, or the client could incorrectly treat a reset from hours ago as the current 100% remaining quota. resetType determines whether to read opportunities/history for the five-hour or weekly quota. has_unread_history is a single cursor shared by both reset types, so only the type with the newest used_at owns this unread marker. Otherwise a weekly reset could make stale five-hour history look newly completed, or vice versa. */
export function applyCodingPlanQuotaResetStatus(
  previous: CodingPlanQuotaResetUiEntry | null,
  status: CodingPlanResetStatusSnapshot,
  now: number,
  manualStartedAt: number | null = null,
  resetType: CodingPlanResetType = "FIVE_HOUR",
): CodingPlanQuotaResetUiEntry | null {
  const availableResets =
    resetType === "WEEK" ? status.availableWeekResets : status.availableFiveHourResets;
  const latestUsedAt =
    (resetType === "WEEK"
      ? status.latestWeekResetHistory?.usedAt
      : status.latestFiveHourResetHistory?.usedAt) ?? null;
  const otherUsedAt =
    (resetType === "WEEK"
      ? status.latestFiveHourResetHistory?.usedAt
      : status.latestWeekResetHistory?.usedAt) ?? null;
  // The shared has_unread_history belongs only to the type with the latest used_at; on a tie, assign it to the current type.
  // This ensures at least one type can enter completed when there is new history, without both types claiming it.
  const ownsUnread =
    status.hasUnreadHistory &&
    latestUsedAt !== null &&
    (otherUsedAt === null || latestUsedAt >= otherUsedAt);
  const validOpportunities = availableResets
    .filter((item) => Number.isFinite(item.expireAt) && item.expireAt > now)
    .sort((left, right) => left.expireAt - right.expireAt);
  // Sticky completion for the same used_at and attribution of shared manual history apply only when there is no new opportunity.
  // The backend may grant another opportunity in the same reset cycle (without changing used_at). If completed keeps taking priority,
  // the UI permanently hides the new opportunity until the user signs in again and clears the window's in-memory state. A valid new
  // opportunity starts a new cycle and returns to AVAILABLE. ownsUnread (a newly discovered unread completion) is unaffected: show the
  // completion message and correct the quota first, then yield on the next cycle after history/read. Processing reconciliation is also
  // unaffected: while opportunities remain, the manual /use confirmation loop must still see completed.
  const hasValidOpportunity = validOpportunities.length > 0;
  const shouldComplete = Boolean(
    latestUsedAt !== null &&
    (ownsUnread ||
      previous?.status === "processing" ||
      ((manualStartedAt !== null ||
        (previous?.status === "completed" && previous.completedAt === latestUsedAt)) &&
        !hasValidOpportunity)),
  );
  if (shouldComplete && latestUsedAt !== null) {
    return createCompletedEntry(
      previous,
      latestUsedAt,
      now,
      manualStartedAt,
      resolveCodingPlanQuotaResetDurationMs(resetType),
    );
  }

  // While manual use is in progress, status polling may still return the pre-redemption snapshot. Keep processing in that case;
  // only server used_at confirms success, and an old opportunity must not revert the state to clickable.
  if (previous?.status === "processing") {
    return previous;
  }

  const earliest = validOpportunities[0];
  if (earliest) {
    return createAvailableEntry(
      validOpportunities.length,
      earliest.expireAt,
      previous?.status === "available" ? previous.idempotencyKey : null,
    );
  }

  return null;
}

export function startCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  idempotencyKey: string,
  now: number,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "available") {
    return entry;
  }

  return {
    ...entry,
    status: "processing",
    // Preserve the opportunity snapshot from before the click while processing, so a failure can restore it without loss and reuse the idempotency key.
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: now,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey: entry.idempotencyKey ?? idempotencyKey,
    error: null,
  };
}

export function failCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  error: string,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "processing") {
    return entry;
  }

  return {
    ...entry,
    status: "available",
    // Failure recovery must preserve the pre-click opportunity count and expiration time; otherwise the entry disappears
    // and the user cannot retry the same redemption with its original idempotency key.
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    error,
  };
}

/** Combine opportunity badges for five-hour and weekly quotas: show one gift badge and add their counts. Use the earliest expiration among visible opportunities for the countdown; when one type expires or is hidden, fall back to the remaining type. This affects only the badge; reset buttons remain independent by type. */
export function mergeCodingPlanQuotaResetOpportunityBadges(
  items: ReadonlyArray<{
    count: number;
    expiresAt: number | null;
    visible: boolean;
  }>,
): { count: number; expiresAt: number | null; visible: boolean } {
  const visibleItems = items.filter((item) => item.visible && item.count > 0);
  return {
    count: visibleItems.reduce((sum, item) => sum + item.count, 0),
    expiresAt:
      visibleItems
        .map((item) => item.expiresAt)
        .filter((value): value is number => value !== null)
        .sort((left, right) => left - right)[0] ?? null,
    visible: visibleItems.length > 0,
  };
}

export function completeCodingPlanQuotaResetEntitlementRefresh(
  entry: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    entry?.status !== "completed" ||
    entry.completedAt !== completedAt ||
    !entry.quotaOverridePending
  ) {
    return entry;
  }
  return { ...entry, quotaOverridePending: false };
}

export function resolveCodingPlanQuotaResetLimit(
  limit: UsageQuotaLimit | null | undefined,
  entry: CodingPlanQuotaResetUiEntry | null,
): UsageQuotaLimit | null {
  if (!limit) {
    return null;
  }
  if (entry?.status !== "completed") {
    return limit;
  }
  if (!entry.quotaOverridePending) {
    // After reset, the quota pool has no active window (a new window starts with the next prompt), so refreshed quota data may lack
    // nextResetTime. Entitlement refresh happens almost at the same time as completion, so the optimistic update lasts only a few
    // hundred milliseconds and the "reset time" disappears almost immediately. Keep using completedAt + interval as a fallback while
    // completed; yield as soon as the server provides a real window (after the user sends a new message). Do not override percentage; use refreshed data.
    return limit.nextResetTime == null && entry.nextResetAt !== null
      ? { ...limit, nextResetTime: entry.nextResetAt }
      : limit;
  }

  return {
    ...limit,
    // The quota API's percentage is the share already used; in the completed UI state, override it to 0% used (100% remaining).
    percentage: 0,
    nextResetTime: entry.nextResetAt ?? limit.nextResetTime,
  };
}

// available is represented by the gift badge + "Reset" button, so do not open the toolbar tooltip.
// The button already shows loading for manual reset and plays confetti on success; showing a processing/completed tooltip here
// would duplicate feedback. Keep the brief message only for automatic/operational completion (startedAt is null).
export function resolveCodingPlanQuotaResetStatusVisible(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  doneDisplayMs: number = CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
): boolean {
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return false;
  }
  return now - entry.observedAt < doneDisplayMs;
}

// Synthesized phases for the automatic/operational reset message on the Composer trigger:
// - processing: about 1 second after first observation, show "Resetting" to recreate server processing (the backend has no processing signal).
// - completed: then switch to "Reset" and keep it until the user hovers over the trigger to view the quota panel and the component dismisses it.
// Return null when dismissed=true (already dismissed on hover) or when this is not an automatic completion (manual startedAt, incomplete, or not observed).
export type CodingPlanQuotaResetAutomaticPhase = "processing" | "completed";

export function resolveCodingPlanQuotaResetAutomaticPhase(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  dismissed: boolean,
  processingMs: number = CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
): CodingPlanQuotaResetAutomaticPhase | null {
  if (dismissed) {
    return null;
  }
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return null;
  }
  return now - entry.observedAt < processingMs ? "processing" : "completed";
}

/** Clear a stale replay-confetti arm: if its used_at is no longer the active automatic completion (observedAt was cleared by cross-window suppression, or a newer used_at replaced it), clear the arm. Otherwise another window could still play confetti from the "Reset" state on panel hover, violating the one-play-across-windows rule. */
export function pruneCodingPlanQuotaResetConfettiArms(
  arms: Record<CodingPlanResetType, number | null>,
  automaticCompletedAtByType: Record<CodingPlanResetType, number | null>,
): Record<CodingPlanResetType, number | null> {
  let changed = false;
  const next = { ...arms };
  for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
    const armed = next[resetType];
    if (armed !== null && automaticCompletedAtByType[resetType] !== armed) {
      next[resetType] = null;
      changed = true;
    }
  }
  return changed ? next : arms;
}
