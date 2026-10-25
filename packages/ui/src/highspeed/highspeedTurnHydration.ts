// Pure hydration/merge logic from transcript to in-memory records. Split out of highspeedTurnStore:
// the store is only the state owner and query surface, and merge policy converges here so it can be
// understood and tested in isolation. This module never touches store state and reads only via the
// injected context, so there is no runtime circular dependency with the store (only compile-time
// erased type imports remain).
import type { HighspeedMessageMeta } from "@zcode/shared";
import type {
  HighspeedTranscriptRow,
  HighspeedTurnMetrics,
  HighspeedTurnRecord,
} from "@/highspeed/highspeedTurnStore.js";

const METRIC_KEYS = [
  "outputTokens",
  "durationMs",
  "modelDurationMs",
  "toolDurationMs",
  "otherDurationMs",
  "regularTps",
  "highspeedTps",
  "savedDurationMs",
] as const satisfies readonly (keyof HighspeedTurnMetrics)[];

/** Result of hydrating a batch of transcript rows; the store applies it in order and notifies subscribers once. */
export interface HighspeedHydrationPlan {
  /** Records to persist, in transcript order; `existed` distinguishes replacing an existing record from a new registration. */
  records: Array<{ record: HighspeedTurnRecord; existed: boolean }>;
  /** Card-level TPS values to write. */
  cardTps: Array<[cardId: string, highspeedTps: number]>;
  /** Number of changed rows; 0 means the batch had no changes and the caller need not notify subscribers. */
  changedRows: number;
}

export interface HighspeedHydrationContext {
  sessionId: string;
  now: number;
  findRecord(sourceCommandId: string): HighspeedTurnRecord | null;
  getCardTps(cardId: string): number | undefined;
}

type HydratableRow = HighspeedTranscriptRow & {
  sourceCommandId: string;
  highspeed: HighspeedMessageMeta;
};

function sameMetrics(a: HighspeedTurnMetrics | undefined, b: HighspeedTurnMetrics | undefined) {
  if (!a || !b) return a === b;
  return METRIC_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Merges the transcript's authoritative meta into a (possibly existing) record. Transcript/CLI
 * persistence is the authoritative cross-device recovery fact: settled fields overwrite transient
 * runtime values, and completed fields are never cleared while the meta is still runtime-state.
 * Returns null when no field changed, letting the caller skip notification.
 */
function mergeTranscriptRow(
  existing: HighspeedTurnRecord | null,
  sessionId: string,
  row: HydratableRow,
  now: number,
  highspeedTpsOfCard: number | undefined,
): HighspeedTurnRecord | null {
  const meta = row.highspeed;
  const base: HighspeedTurnRecord = existing ?? {
    sessionId,
    sourceCommandId: row.sourceCommandId,
    card: {
      cardId: meta.cardId,
      taskId: meta.taskId,
      provider: meta.provider,
      model: meta.model,
      issuedAt: meta.issuedAt,
      expiresAt: meta.expiresAt,
      ...(meta.regularTps !== undefined ? { regularTps: meta.regularTps } : {}),
    },
    createdAt: row.createdAt,
  };
  let next = base;
  // regularTps sampled at send time is a persisted fact; backfill it when the in-memory record lacks it.
  if (meta.regularTps !== undefined && next.card.regularTps !== meta.regularTps) {
    next = { ...next, card: { ...next.card, regularTps: meta.regularTps } };
  }
  if (meta.outputTokens !== undefined && meta.durationMs !== undefined) {
    const metrics: HighspeedTurnMetrics = {
      ...next.metrics,
      outputTokens: Math.max(0, Math.floor(meta.outputTokens)),
      durationMs: Math.max(0, meta.durationMs),
      ...(meta.modelDurationMs !== undefined
        ? { modelDurationMs: Math.max(0, meta.modelDurationMs) }
        : {}),
      ...(meta.toolDurationMs !== undefined
        ? { toolDurationMs: Math.max(0, meta.toolDurationMs) }
        : {}),
      ...(meta.otherDurationMs !== undefined
        ? { otherDurationMs: Math.max(0, meta.otherDurationMs) }
        : {}),
      regularTps: meta.regularTps ?? next.metrics?.regularTps ?? next.card.regularTps ?? 0,
    };
    if (!sameMetrics(next.metrics, metrics)) {
      next = { ...next, completedAt: next.completedAt ?? now, metrics };
    }
  }
  // Same policy as markHighspeedTurnMetricsPersisted: savedDurationMs lands only with card-level
  // TPS available; already-marked records are not marked twice.
  const highspeedTps = meta.highspeedTps ?? highspeedTpsOfCard;
  if (
    meta.savedDurationMs !== undefined &&
    next.metrics &&
    highspeedTps &&
    next.metricsPersistedAt === undefined
  ) {
    next = {
      ...next,
      metricsPersistedAt: now,
      metrics: {
        ...next.metrics,
        highspeedTps,
        savedDurationMs: Math.max(0, meta.savedDurationMs),
      },
    };
  }
  return existing && next === base ? null : next;
}

/**
 * Cold-start restore and cross-device catch-up: the renderer may be absent at expiry, leaving the
 * in-memory store no chance to register or settle the card; a remote-control Renderer may also
 * register a running row before the desktop later persists the settled state into the transcript.
 * userInput.highspeed in the transcript is the persisted fact and is merged idempotently by
 * sourceCommandId (spec §8).
 * Bug root cause: the old implementation skipped existing sourceCommandIds with continue, so late
 * outputTokens/durationMs/highspeedTps/savedDurationMs were never absorbed, and the remote card
 * TPS, saved time, and auto-share candidates could never settle.
 */
export function planHighspeedTranscriptHydration(
  rows: readonly HighspeedTranscriptRow[],
  context: HighspeedHydrationContext,
): HighspeedHydrationPlan {
  const plan: HighspeedHydrationPlan = { records: [], cardTps: [], changedRows: 0 };
  // Later rows in the same batch must see records and card-level TPS produced by earlier rows,
  // matching the old row-by-row persistence semantics.
  const stagedByCommandId = new Map<string, number>();
  const stagedCardTps = new Map<string, number>();
  for (const row of rows) {
    const meta = row.highspeed;
    if (!meta || !row.sourceCommandId) continue;
    const sourceCommandId = row.sourceCommandId;
    const stagedIndex = stagedByCommandId.get(sourceCommandId);
    const staged = stagedIndex === undefined ? undefined : plan.records[stagedIndex];
    const existing = staged?.record ?? context.findRecord(sourceCommandId);
    let changed = false;
    let cardTps = stagedCardTps.get(meta.cardId) ?? context.getCardTps(meta.cardId);
    // Same guard as setHighspeedCardTps: non-positive or non-finite values are not persisted and
    // do not count as a change.
    if (
      meta.highspeedTps !== undefined &&
      Number.isFinite(meta.highspeedTps) &&
      meta.highspeedTps > 0 &&
      cardTps !== meta.highspeedTps
    ) {
      stagedCardTps.set(meta.cardId, meta.highspeedTps);
      plan.cardTps.push([meta.cardId, meta.highspeedTps]);
      cardTps = meta.highspeedTps;
      changed = true;
    }
    const merged = mergeTranscriptRow(
      existing,
      context.sessionId,
      { ...row, sourceCommandId, highspeed: meta },
      context.now,
      cardTps,
    );
    if (merged) {
      if (stagedIndex !== undefined && staged) {
        plan.records[stagedIndex] = { record: merged, existed: staged.existed };
      } else {
        stagedByCommandId.set(sourceCommandId, plan.records.length);
        plan.records.push({ record: merged, existed: existing !== null });
      }
      changed = true;
    }
    if (changed) plan.changedRows += 1;
  }
  return plan;
}
