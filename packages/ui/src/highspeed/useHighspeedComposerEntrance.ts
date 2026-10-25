import { useEffect, useState } from "react";

/** Highspeed composer entrance style: "activation" plays the activation animation, "restore" shows the stable state directly. */
export type HighspeedComposerEntrance = "activation" | "restore";

function resolveEntrance(
  cardId: string | null,
  activationCardId: string | null,
): HighspeedComposerEntrance {
  return cardId !== null && cardId === activationCardId ? "activation" : "restore";
}

/**
 * Latches the entrance style by cardId: the activation animation plays only when the host's
 * one-shot activation request hits the current card; switching back to a Task, snapshot restore,
 * and component remount always use restore (spec §9.2).
 * The request is consumed via callback immediately after latching, so later remounts cannot see it
 * and never replay.
 */
export function useHighspeedComposerEntrance({
  cardId,
  activationCardId,
  onActivationApplied,
}: {
  cardId: string | null;
  activationCardId: string | null;
  onActivationApplied?: (cardId: string) => void;
}): HighspeedComposerEntrance {
  const [latch, setLatch] = useState(() => ({
    cardId,
    entrance: resolveEntrance(cardId, activationCardId),
  }));
  let current = latch;
  if (latch.cardId !== cardId) {
    // Re-latch during render when the card identity changes, so a new card never renders one
    // frame with the old entrance style.
    current = { cardId, entrance: resolveEntrance(cardId, activationCardId) };
    setLatch(current);
  }
  const appliedActivationCardId = current.entrance === "activation" ? current.cardId : null;
  useEffect(() => {
    if (appliedActivationCardId !== null) onActivationApplied?.(appliedActivationCardId);
  }, [appliedActivationCardId, onActivationApplied]);
  return current.entrance;
}
