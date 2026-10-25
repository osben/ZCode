import type { HighspeedMessageMeta } from "@zcode/shared";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import type { HighspeedShareMetrics } from "@/highspeed/highspeedTurnStore.js";

export interface HighspeedOutputFooterTarget {
  cardId: string;
  metrics: HighspeedShareMetrics;
}

/** Marker fields written back to render units by the footer consolidation logic; host types only need to declare these two optional fields. */
export interface HighspeedOutputFooterMark {
  /** The current last turn for the same Highspeed cardId; only this group tail may show the attribution footer. */
  showHighspeedOutputFooter?: true;
  /** Trustworthy share metrics aggregated on cold restore from all persisted turn metadata of the same card. */
  highspeedOutputFooterTarget?: HighspeedOutputFooterTarget;
}

interface HighspeedFooterUnit {
  visibleUserInputs: readonly { highspeed?: HighspeedMessageMeta }[];
  assistantWorkRows: readonly { kind: string }[];
}

interface HighspeedCardFooterState {
  lastUnitIndex: number;
  hasOutput: boolean;
  metas: HighspeedMessageMeta[];
}

/**
 * Marks the last render unit covered by the same card with the footer flag.
 *
 * Bug root cause: the footer was previously decided per turn by the accelerated flag, so a card
 * spanning multiple turns displayed it repeatedly. It must be consolidated before virtualization
 * by persisted cardId and expiry time, so the group tail moves back stably with new turns and the
 * countdown.
 */
export function markHighspeedOutputFooterUnits<T extends HighspeedFooterUnit>(
  units: readonly T[],
  nowMs: number,
): (T & HighspeedOutputFooterMark)[] {
  const footerByUnitIndex = resolveHighspeedOutputFooters(units, nowMs);
  return units.map((unit, index) => {
    if (!footerByUnitIndex.has(index)) return unit;
    const target = footerByUnitIndex.get(index);
    return {
      ...unit,
      showHighspeedOutputFooter: true as const,
      ...(target ? { highspeedOutputFooterTarget: target } : {}),
    };
  });
}

function resolveHighspeedOutputFooters(
  units: readonly HighspeedFooterUnit[],
  nowMs: number,
): Map<number, HighspeedOutputFooterTarget | null> {
  const cardsByUnit = units.map((unit) =>
    unit.visibleUserInputs.flatMap((row) => (row.highspeed ? [row.highspeed] : [])),
  );
  const cardStateById = new Map<string, HighspeedCardFooterState>();

  cardsByUnit.forEach((cards, index) => {
    for (const card of cards) {
      const current = cardStateById.get(card.cardId);
      cardStateById.set(card.cardId, {
        lastUnitIndex: index,
        // Bug cause: an interrupted/errored group tail may have no body itself, while earlier
        // accelerated turns already produced output. The footer belongs to the whole card and
        // cannot look only at the last turn; a timeline boundary is not model output and is not counted.
        hasOutput:
          (current?.hasOutput ?? false) ||
          (card.outputTokens ?? 0) > 0 ||
          units[index]!.assistantWorkRows.some((row) => row.kind !== "timelineMarker"),
        metas: [...(current?.metas ?? []), card],
      });
    }
  });

  const footerByUnitIndex = new Map<number, HighspeedOutputFooterTarget | null>();
  cardsByUnit.forEach((cards, index) => {
    const footerCard = cards.find((card) => {
      const state = cardStateById.get(card.cardId);
      return card.expiresAt <= nowMs && state?.lastUnitIndex === index && state.hasOutput;
    });
    if (!footerCard) return;
    const metrics = aggregatePersistedHighspeedMetrics(
      cardStateById.get(footerCard.cardId)?.metas ?? [],
    );
    footerByUnitIndex.set(index, metrics ? { cardId: footerCard.cardId, metrics } : null);
  });
  return footerByUnitIndex;
}

function aggregatePersistedHighspeedMetrics(
  metas: readonly HighspeedMessageMeta[],
): HighspeedShareMetrics | null {
  if (
    metas.length === 0 ||
    metas.some(
      (meta) =>
        meta.outputTokens === undefined ||
        meta.regularTps === undefined ||
        meta.regularTps <= 0 ||
        meta.highspeedTps === undefined ||
        meta.highspeedTps <= 0,
    )
  ) {
    return null;
  }
  const outputTokens = metas.reduce((total, meta) => total + (meta.outputTokens ?? 0), 0);
  if (outputTokens <= 0) return null;
  const regularDurationSeconds = metas.reduce(
    (total, meta) => total + (meta.outputTokens ?? 0) / (meta.regularTps ?? 1),
    0,
  );
  const savedDurationMs = metas.reduce(
    (total, meta) =>
      total +
      (meta.savedDurationMs ??
        calculateHighspeedSavedDurationMs({
          outputTokens: meta.outputTokens ?? 0,
          regularTps: meta.regularTps ?? 0,
          highspeedTps: meta.highspeedTps ?? 0,
          durationMs: meta.durationMs ?? 0,
          modelDurationMs: meta.modelDurationMs,
          toolDurationMs: meta.toolDurationMs,
          otherDurationMs: meta.otherDurationMs,
        })),
    0,
  );
  return {
    outputTokens,
    durationMs: metas.reduce((total, meta) => total + (meta.durationMs ?? 0), 0),
    ...(metas.every(
      (meta) => meta.modelDurationMs !== undefined && meta.toolDurationMs !== undefined,
    )
      ? {
          modelDurationMs: metas.reduce((total, meta) => total + (meta.modelDurationMs ?? 0), 0),
          toolDurationMs: metas.reduce((total, meta) => total + (meta.toolDurationMs ?? 0), 0),
          otherDurationMs: metas.reduce(
            (total, meta) =>
              total +
              (meta.otherDurationMs ??
                Math.max(
                  0,
                  (meta.durationMs ?? 0) - (meta.modelDurationMs ?? 0) - (meta.toolDurationMs ?? 0),
                )),
            0,
          ),
        }
      : {}),
    savedDurationMs,
    regularTps: outputTokens / regularDurationSeconds,
    // The healthy endpoint returns the card-level aggregate TPS; every turn of the same card persists the same authoritative value.
    highspeedTps: metas[0]!.highspeedTps!,
  };
}
