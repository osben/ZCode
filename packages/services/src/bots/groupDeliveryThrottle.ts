/** Shared send pacing for group messages; only reserves send times, never stores or executes task input. */
export function createGroupDeliveryThrottle() {
  const nextSendAt = new Map<string, number>();
  return async (chatKey: string): Promise<void> => {
    const now = Date.now();
    const at = Math.max(now, nextSendAt.get(chatKey) ?? now);
    nextSendAt.set(chatKey, at + 250);
    if (at > now) await new Promise<void>((resolve) => setTimeout(resolve, at - now));
    // Idle keys are not kept around; never clear a key's reserved slot while a later call still depends on it.
    if ((nextSendAt.get(chatKey) ?? 0) <= Date.now()) nextSendAt.delete(chatKey);
  };
}
