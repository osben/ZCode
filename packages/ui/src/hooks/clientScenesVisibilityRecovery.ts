type VisibilityDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/** Page Visibility recovery coordinator: one authority may have multiple React consumers, but reopening runs only one callback. */
export function createClientScenesVisibilityRecovery(documentTarget: VisibilityDocument) {
  const activeRevalidators = new Map<object, Set<() => void>>();
  const handledGenerations = new WeakMap<object, number>();
  let listening = false;
  let rendererWasHidden = false;
  let reopenGeneration = 0;

  const handleVisibilityChange = () => {
    if (documentTarget.visibilityState === "hidden") {
      rendererWasHidden = true;
      return;
    }
    if (!rendererWasHidden) return;
    rendererWasHidden = false;
    reopenGeneration += 1;

    for (const [authority, revalidators] of activeRevalidators) {
      const revalidate = revalidators.values().next().value;
      if (!revalidate) continue;
      handledGenerations.set(authority, reopenGeneration);
      revalidate();
    }
  };

  return {
    subscribe(authority: object, revalidate: () => void): () => void {
      if (!listening) {
        listening = true;
        rendererWasHidden = documentTarget.visibilityState === "hidden";
        documentTarget.addEventListener("visibilitychange", handleVisibilityChange);
      }

      const revalidators = activeRevalidators.get(authority) ?? new Set<() => void>();
      revalidators.add(revalidate);
      activeRevalidators.set(authority, revalidators);
      const handledGeneration = handledGenerations.get(authority);
      if (handledGeneration === undefined) {
        handledGenerations.set(authority, reopenGeneration);
      } else if (handledGeneration < reopenGeneration) {
        handledGenerations.set(authority, reopenGeneration);
        revalidate();
      }

      return () => {
        // The renderer may be hidden and shown while no Scene consumer is mounted. Preserve the
        // authority's processed generation so the next mount can still observe invalidation instead
        // of continuing to use the ten-minute cache from before reopening.
        revalidators.delete(revalidate);
        if (revalidators.size === 0) activeRevalidators.delete(authority);
      };
    },
  };
}
