export type GroupInputReaction = "waiting" | "working" | "done" | "failed" | "cancelled";

const rank: Record<GroupInputReaction, number> = {
  waiting: 0,
  working: 1,
  done: 2,
  failed: 2,
  cancelled: 2,
};

export function createGroupInputReactionUpdater(
  apply: (key: string, state: GroupInputReaction) => Promise<void>,
) {
  const entries = new Map<
    string,
    {
      desired: GroupInputReaction;
      applied?: GroupInputReaction;
      pending: Promise<void>;
    }
  >();
  return (key: string, state: GroupInputReaction): Promise<void> => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { desired: state, pending: Promise.resolve() };
      entries.set(key, entry);
    } else if (
      rank[state] < rank[entry.desired] ||
      (rank[entry.desired] === 2 && state !== entry.desired)
    ) {
      return Promise.resolve();
    }
    entry.desired = state;
    const current = entry;
    // Receipts may arrive after start/end events; serialize per message and forbid status regression so terminal states are never overwritten.
    current.pending = current.pending
      .catch(() => {})
      .then(async () => {
        if (current.applied === state) return;
        await apply(key, state);
        current.applied = state;
      });
    return current.pending;
  };
}
