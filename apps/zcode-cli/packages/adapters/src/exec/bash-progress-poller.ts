type ProgressSubscriber = {
  reading: boolean;
  poll: (isActive: () => boolean) => Promise<void>;
};
type PollingGroup = {
  subscribers: Set<ProgressSubscriber>;
  timer: NodeJS.Timeout;
};

// Share pollers by interval: the product normally uses one 1-second poller, and custom internal
// intervals do not change the frequency of other tasks.
const pollingGroups = new Map<number, PollingGroup>();

export function subscribeBashOutputProgress(
  intervalMs: number,
  poll: ProgressSubscriber["poll"],
): () => void {
  let group = pollingGroups.get(intervalMs);
  if (!group) {
    const subscribers = new Set<ProgressSubscriber>();
    const timer = setInterval(() => {
      for (const subscriber of subscribers) {
        if (subscriber.reading) continue;
        subscriber.reading = true;
        const isActive = () => subscribers.has(subscriber);
        void Promise.resolve()
          .then(() => {
            if (isActive()) return subscriber.poll(isActive);
          })
          // Preview reads are best effort; a single file or callback failure must not stop shared
          // progress updates for other Bash processes.
          .catch(() => undefined)
          .finally(() => {
            subscriber.reading = false;
          });
      }
    }, intervalMs);
    timer.unref();
    group = { subscribers, timer };
    pollingGroups.set(intervalMs, group);
  }
  const subscriber = { reading: false, poll };
  const { subscribers, timer } = group;
  subscribers.add(subscriber);
  return () => {
    // Repeated cleanup by an old subscription must not remove a new poller for the same interval.
    if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
    clearInterval(timer);
    pollingGroups.delete(intervalMs);
  };
}
