import {
  aggregateHighspeedCardMetrics,
  listHighspeedTurnsByCard,
  listHighspeedTurnsBySession,
} from "@/highspeed/highspeedTurnStore.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";

/**
 * Diagnostics: why this card is not yet an auto-share candidate; an empty array means ready.
 * The gate conditions match turnStore.listHighspeedCardAutoShareCandidates; unit tests
 * cross-assert that the two never drift. This module only serves debug logging and takes no part
 * in business decisions.
 */
export function collectHighspeedCardShareBlockers(cardId: string): string[] {
  const cardRecords = listHighspeedTurnsByCard(cardId);
  const blockers: string[] = [];
  if (cardRecords.length === 0) {
    return ["no-records"];
  }
  for (const record of cardRecords) {
    if (!record.metrics) {
      blockers.push(`turn-metrics-missing:${record.sourceCommandId}`);
      continue;
    }
    if (record.metrics.regularTps <= 0) {
      blockers.push(`turn-regular-tps-zero:${record.sourceCommandId}`);
    }
    if (record.metricsPersistedAt === undefined) {
      blockers.push(`turn-metrics-not-persisted:${record.sourceCommandId}`);
    }
    if (record.autoShareAttemptedAt !== undefined || record.autoSharedAt !== undefined) {
      blockers.push("auto-share-attempted");
    }
  }
  if (blockers.length === 0) {
    const metrics = aggregateHighspeedCardMetrics(cardId);
    if (metrics.outputTokens <= 0) {
      // Same policy as the candidate check: a card with no generated output must not be shared,
      // and token_usage must not be forced to 1.
      blockers.push("zero-output");
    } else if (!isHighspeedShareEligible(metrics)) {
      // Same policy as the candidate check: an overall speedup of <=1.2x does not publish the
      // bottom-left card (spec §9); the reason is named here for debugging.
      blockers.push("below-min-speedup");
    }
  }
  return blockers;
}

/**
 * Diagnostics: cards in a session that have expired but have not yet attempted an auto-share.
 * Used by debug logs to answer "why has the bottom-left share card not updated"; does not change
 * sharing behavior.
 */
export function listHighspeedCardsAwaitingAutoShare(sessionId: string, now: number): string[] {
  const pendingRecords = listHighspeedTurnsBySession(sessionId).filter(
    (record) => record.autoShareAttemptedAt === undefined && record.autoSharedAt === undefined,
  );
  const cardsById = new Map<string, typeof pendingRecords>();
  for (const record of pendingRecords) {
    const list = cardsById.get(record.card.cardId) ?? [];
    list.push(record);
    cardsById.set(record.card.cardId, list);
  }
  return [...cardsById.entries()]
    .filter(([, records]) => records.every((record) => record.card.expiresAt <= now))
    .map(([cardId]) => cardId);
}
