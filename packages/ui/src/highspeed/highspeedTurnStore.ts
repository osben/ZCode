import type { HighspeedCardSnapshot, HighspeedMessageMeta } from "@zcode/shared";
import { planHighspeedTranscriptHydration } from "@/highspeed/highspeedTurnHydration.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";

export interface HighspeedTranscriptRow {
  sourceCommandId?: string;
  createdAt: number;
  highspeed?: HighspeedMessageMeta;
}

export interface HighspeedTurnMetrics {
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  regularTps: number;
  highspeedTps?: number;
  savedDurationMs?: number;
}

export interface HighspeedShareMetrics extends HighspeedTurnMetrics {
  highspeedTps: number;
}

export interface HighspeedTurnRecord {
  sessionId: string;
  sourceCommandId: string;
  card: HighspeedCardSnapshot;
  createdAt: number;
  completedAt?: number;
  metrics?: HighspeedTurnMetrics;
  metricsPersistedAt?: number;
  autoShareAttemptedAt?: number;
  autoSharedAt?: number;
}

export interface HighspeedCardAutoShareCandidate {
  cardId: string;
  expiresAt: number;
  metrics: HighspeedShareMetrics;
}

const MAX_RECORDS = 300;

let records: HighspeedTurnRecord[] = [];
const highspeedTpsByCardId = new Map<string, number>();
const healthyAttemptsByCardId = new Map<
  string,
  { expiryAttempted: boolean; completionRetryAttempted: boolean }
>();
const listeners = new Set<() => void>();

function publishChange(): void {
  for (const listener of listeners) listener();
}

export function recordHighspeedTurn(record: HighspeedTurnRecord): void {
  records = [
    record,
    ...records.filter((candidate) => candidate.sourceCommandId !== record.sourceCommandId),
  ].slice(0, MAX_RECORDS);
  publishChange();
}

/**
 * Cold-start restore and cross-device catch-up: the renderer may be absent at expiry, leaving the
 * in-memory store no chance to register or settle the card; a remote-control Renderer may also
 * register a running row before the desktop later persists the settled state into the transcript.
 * Merge policy is defined in planHighspeedTranscriptHydration; this only persists in order and
 * notifies once. Returns the number of changed rows; no notification when nothing changed, so
 * repeated hydration cannot cause render churn.
 */
export function hydrateHighspeedTurnsFromTranscript(
  sessionId: string,
  rows: readonly HighspeedTranscriptRow[],
): number {
  const plan = planHighspeedTranscriptHydration(rows, {
    sessionId,
    now: Date.now(),
    findRecord: getHighspeedTurnByCommandId,
    getCardTps: getHighspeedCardTps,
  });
  for (const [cardId, highspeedTps] of plan.cardTps) {
    highspeedTpsByCardId.set(cardId, highspeedTps);
  }
  for (const { record, existed } of plan.records) {
    records = existed
      ? records.map((candidate) =>
          candidate.sourceCommandId === record.sourceCommandId ? record : candidate,
        )
      : [record, ...records].slice(0, MAX_RECORDS);
  }
  if (plan.changedRows > 0) publishChange();
  return plan.changedRows;
}

export function discardHighspeedTurn(sourceCommandId: string): boolean {
  const nextRecords = records.filter((record) => record.sourceCommandId !== sourceCommandId);
  if (nextRecords.length === records.length) return false;
  records = nextRecords;
  publishChange();
  return true;
}

export function completeHighspeedTurn(params: {
  sourceCommandId: string;
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  completedAt?: number;
}): HighspeedTurnRecord | null {
  const current = getHighspeedTurnByCommandId(params.sourceCommandId);
  if (!current) return null;
  if (current.metrics) return current;
  const completed: HighspeedTurnRecord = {
    ...current,
    completedAt: params.completedAt ?? Date.now(),
    metrics: {
      outputTokens: Math.max(0, Math.floor(params.outputTokens)),
      durationMs: Math.max(0, params.durationMs),
      ...(params.modelDurationMs !== undefined
        ? { modelDurationMs: Math.max(0, params.modelDurationMs) }
        : {}),
      ...(params.toolDurationMs !== undefined
        ? { toolDurationMs: Math.max(0, params.toolDurationMs) }
        : {}),
      ...(params.otherDurationMs !== undefined
        ? { otherDurationMs: Math.max(0, params.otherDurationMs) }
        : {}),
      regularTps: current.card.regularTps ?? 0,
    },
  };
  records = records.map((record) =>
    record.sourceCommandId === params.sourceCommandId ? completed : record,
  );
  publishChange();
  return completed;
}

export function setHighspeedCardTps(cardId: string, highspeedTps: number): void {
  if (!Number.isFinite(highspeedTps) || highspeedTps <= 0) return;
  if (highspeedTpsByCardId.get(cardId) === highspeedTps) return;
  highspeedTpsByCardId.set(cardId, highspeedTps);
  publishChange();
}

export function getHighspeedCardTps(cardId: string): number | undefined {
  return highspeedTpsByCardId.get(cardId);
}

/**
 * Card-level healthy-query dedup must outlive SessionPane's lifecycle; a component ref is cleared
 * on remount, letting the same expired card keep requesting and amplifying server rate limiting.
 * Each card gets at most one expiry-time query, plus one completion retry if a Turn was still
 * running at that point.
 */
export function claimHighspeedHealthyAttempt(cardId: string, allTurnsCompleted: boolean): boolean {
  const attempts = healthyAttemptsByCardId.get(cardId) ?? {
    expiryAttempted: false,
    completionRetryAttempted: false,
  };
  if (allTurnsCompleted) {
    if (attempts.completionRetryAttempted) return false;
    attempts.completionRetryAttempted = true;
  } else {
    if (attempts.expiryAttempted) return false;
    attempts.expiryAttempted = true;
  }
  healthyAttemptsByCardId.set(cardId, attempts);
  return true;
}

export function markHighspeedTurnMetricsPersisted(
  sourceCommandId: string,
  savedDurationMs: number,
  persistedAt = Date.now(),
): void {
  let changed = false;
  records = records.map((record) => {
    if (
      record.sourceCommandId !== sourceCommandId ||
      !record.metrics ||
      record.metricsPersistedAt !== undefined
    ) {
      return record;
    }
    const highspeedTps = getHighspeedCardTps(record.card.cardId);
    if (!highspeedTps) return record;
    changed = true;
    return {
      ...record,
      metricsPersistedAt: persistedAt,
      metrics: {
        ...record.metrics,
        highspeedTps,
        savedDurationMs: Math.max(0, savedDurationMs),
      },
    };
  });
  if (changed) publishChange();
}

export function markHighspeedCardAutoShared(cardId: string, autoSharedAt = Date.now()): void {
  let changed = false;
  records = records.map((record) => {
    if (record.card.cardId !== cardId || record.autoSharedAt !== undefined) return record;
    changed = true;
    return { ...record, autoSharedAt };
  });
  if (changed) publishChange();
}

export function claimHighspeedCardAutoShare(
  cardId: string,
  attemptedAt = Date.now(),
): HighspeedTurnRecord[] | null {
  const cardRecords = listHighspeedTurnsByCard(cardId);
  const metrics = aggregateHighspeedCardMetrics(cardId);
  if (
    cardRecords.length === 0 ||
    metrics.outputTokens <= 0 ||
    cardRecords.some(
      (record) =>
        !record.metrics ||
        record.metrics.regularTps <= 0 ||
        record.metricsPersistedAt === undefined ||
        record.autoShareAttemptedAt !== undefined ||
        record.autoSharedAt !== undefined ||
        record.card.expiresAt > attemptedAt,
    )
  ) {
    return null;
  }
  const claimed = cardRecords.map((record) => ({ ...record, autoShareAttemptedAt: attemptedAt }));
  const claimedByCommandId = new Map(
    claimed.map((record) => [record.sourceCommandId, record] as const),
  );
  records = records.map((record) => claimedByCommandId.get(record.sourceCommandId) ?? record);
  publishChange();
  return claimed;
}

export function getHighspeedTurnByCommandId(
  sourceCommandId: string | undefined,
): HighspeedTurnRecord | null {
  if (!sourceCommandId) return null;
  return records.find((record) => record.sourceCommandId === sourceCommandId) ?? null;
}

export function listHighspeedTurnsByCard(cardId: string): HighspeedTurnRecord[] {
  return records.filter((record) => record.card.cardId === cardId);
}

export function listHighspeedTurnsBySession(sessionId: string): HighspeedTurnRecord[] {
  return records.filter((record) => record.sessionId === sessionId);
}

export function listPendingHighspeedTurns(sessionId: string): HighspeedTurnRecord[] {
  return listHighspeedTurnsBySession(sessionId).filter((record) => record.metrics === undefined);
}

export function listExpiredHighspeedCardsAwaitingTps(
  sessionId: string,
  now: number,
): Array<{ cardId: string; allTurnsCompleted: boolean }> {
  const sessionRecords = listHighspeedTurnsBySession(sessionId);
  const cardIds = [...new Set(sessionRecords.map((record) => record.card.cardId))];
  return cardIds.flatMap((cardId) => {
    const cardRecords = sessionRecords.filter((record) => record.card.cardId === cardId);
    if (
      highspeedTpsByCardId.has(cardId) ||
      cardRecords.every((record) => record.card.expiresAt > now)
    ) {
      return [];
    }
    return [{ cardId, allTurnsCompleted: cardRecords.every((record) => record.metrics) }];
  });
}

export function listHighspeedTurnsAwaitingMetricsPersistence(
  sessionId: string,
): HighspeedTurnRecord[] {
  return listHighspeedTurnsBySession(sessionId).filter(
    (record) =>
      record.metrics !== undefined &&
      record.metricsPersistedAt === undefined &&
      getHighspeedCardTps(record.card.cardId) !== undefined,
  );
}

export function listHighspeedCardAutoShareCandidates(
  sessionId: string,
): HighspeedCardAutoShareCandidate[] {
  const sessionRecords = listHighspeedTurnsBySession(sessionId);
  const cardIds = [...new Set(sessionRecords.map((record) => record.card.cardId))];
  return cardIds.flatMap((cardId) => {
    const cardRecords = sessionRecords.filter((record) => record.card.cardId === cardId);
    if (
      cardRecords.some(
        (record) =>
          !record.metrics ||
          record.metrics.regularTps <= 0 ||
          record.metricsPersistedAt === undefined ||
          record.autoShareAttemptedAt !== undefined ||
          record.autoSharedAt !== undefined,
      )
    ) {
      return [];
    }
    const metrics = aggregateHighspeedCardMetrics(cardId);
    // Bug cause: zero-output cards still entered auto-share, and build request then forced
    // token_usage to 1, violating the "no generated content means no display/share" product
    // semantics and writing fake usage to the backend.
    if (metrics.outputTokens <= 0) return [];
    // Below threshold (overall speedup <=1.2x) does not publish the bottom-left share card: the
    // publish gate matches the "View" button gate, otherwise a half-broken state appears where the
    // card pops up with no View button (spec §9). The diagnostic blocker below-min-speedup stays
    // consistent with this to avoid eligibility drift or silently dropped cards.
    if (!isHighspeedShareEligible(metrics)) return [];
    return [
      {
        cardId,
        expiresAt: Math.max(...cardRecords.map((record) => record.card.expiresAt)),
        metrics,
      },
    ];
  });
}

export function resolveNextHighspeedAutoShareAt(sessionId: string): number | null {
  const sessionRecords = listHighspeedTurnsBySession(sessionId).filter(
    (record) => record.autoShareAttemptedAt === undefined && record.autoSharedAt === undefined,
  );
  if (sessionRecords.length === 0) return null;
  return Math.min(...sessionRecords.map((record) => record.card.expiresAt));
}

export function subscribeHighspeedTurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Records are immutable snapshots. Consumers shallow-compare these dependencies and must not
// subscribe to a global version that updates unrelated sessions together.
// Card-level aggregation spans sessions: it must include all records and TPS of the same card,
// not just the current session's slice.
function highspeedCardDependencies(
  cardIds: ReadonlySet<string>,
): readonly (HighspeedTurnRecord | number | undefined)[] {
  return [
    ...records.filter((record) => cardIds.has(record.card.cardId)),
    ...Array.from(cardIds, getHighspeedCardTps),
  ];
}

export function getHighspeedSessionDependencies(
  sessionId: string | null,
): readonly (HighspeedTurnRecord | number | undefined)[] {
  return highspeedCardDependencies(
    new Set(
      records
        .filter((record) => record.sessionId === sessionId)
        .map((record) => record.card.cardId),
    ),
  );
}

export function getHighspeedTurnDependencies(
  sourceCommandId: string | undefined,
): readonly (HighspeedTurnRecord | number | undefined)[] {
  const record = getHighspeedTurnByCommandId(sourceCommandId);
  return highspeedCardDependencies(new Set(record ? [record.card.cardId] : []));
}

export function aggregateHighspeedCardMetrics(cardId: string): HighspeedShareMetrics {
  const records = listHighspeedTurnsByCard(cardId).filter(
    (record): record is HighspeedTurnRecord & { metrics: HighspeedTurnMetrics } =>
      record.metrics !== undefined,
  );
  const outputTokens = records.reduce((total, record) => total + record.metrics.outputTokens, 0);
  const highspeedTps =
    getHighspeedCardTps(cardId) ??
    records.find((record) => record.metrics.highspeedTps)?.metrics.highspeedTps ??
    0;
  const savedDurationMs = records.reduce(
    (total, record) =>
      total +
      (record.metrics.savedDurationMs ??
        calculateHighspeedSavedDurationMs({
          outputTokens: record.metrics.outputTokens,
          regularTps: record.metrics.regularTps,
          highspeedTps,
          durationMs: record.metrics.durationMs,
          modelDurationMs: record.metrics.modelDurationMs,
          toolDurationMs: record.metrics.toolDurationMs,
          otherDurationMs: record.metrics.otherDurationMs,
        })),
    0,
  );
  const regularDurationSeconds = records.reduce(
    (total, record) =>
      total +
      (record.metrics.regularTps > 0 ? record.metrics.outputTokens / record.metrics.regularTps : 0),
    0,
  );
  const hasRealTiming =
    records.length > 0 &&
    records.every(
      (record) =>
        record.metrics.modelDurationMs !== undefined && record.metrics.toolDurationMs !== undefined,
    );
  return {
    outputTokens,
    durationMs: records.reduce((total, record) => total + record.metrics.durationMs, 0),
    ...(hasRealTiming
      ? {
          modelDurationMs: records.reduce(
            (total, record) => total + (record.metrics.modelDurationMs ?? 0),
            0,
          ),
          toolDurationMs: records.reduce(
            (total, record) => total + (record.metrics.toolDurationMs ?? 0),
            0,
          ),
          otherDurationMs: records.reduce(
            (total, record) =>
              total +
              (record.metrics.otherDurationMs ??
                Math.max(
                  0,
                  record.metrics.durationMs -
                    (record.metrics.modelDurationMs ?? 0) -
                    (record.metrics.toolDurationMs ?? 0),
                )),
            0,
          ),
        }
      : {}),
    savedDurationMs,
    regularTps:
      regularDurationSeconds > 0 ? Number((outputTokens / regularDurationSeconds).toFixed(3)) : 0,
    highspeedTps,
  };
}
