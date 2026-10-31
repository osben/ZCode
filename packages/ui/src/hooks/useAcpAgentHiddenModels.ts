// The model values an ACP agent hides from the composer's agent Model select
// (specs/acp-agent-runtime.md "Settings: models and Advanced"). The host stores the hidden set in
// the fork sidecar; this hook is its only writer and serializes writes (one in flight, the latest
// set wins). A failed write reverts to the last stored set and is announced (SM7).
// Like the rest of the ACP Settings group it writes the workspace host's service it is given
// ("Settings: workspace host"), the same host whose hidden set the composer reads.
import { useCallback, useEffect, useRef, useState } from "react";
import type { IProviderSettingsService } from "@zcode/services";
import { logger } from "@/logger.js";

export interface AcpAgentHiddenModelsHandle {
  /** The shown hidden set: the stored set plus queued optimistic writes. */
  readonly hidden: readonly string[];
  /** The failed write's message; null while no write failed. */
  readonly writeError: string | null;
  /** Optimistically shows `next` and persists it; a failure reverts to the last stored set. */
  readonly setHiddenModels: (next: readonly string[]) => void;
}

interface HiddenModelsQueue {
  readonly service: IProviderSettingsService;
  readonly agentId: string;
  confirmed: readonly string[];
  wanted: readonly string[] | null;
  writing: boolean;
}

export function useAcpAgentHiddenModels(input: {
  /** The workspace host's service (`useAcpSettingsHost`). */
  providerSettingsService: IProviderSettingsService;
  agentId: string;
  /** The host's stored set (undefined while the catalog read is pending or nothing is hidden). */
  storedHidden: readonly string[] | undefined;
}): AcpAgentHiddenModelsHandle {
  const { agentId, providerSettingsService } = input;
  const storedHidden = input.storedHidden;
  const [hidden, setHidden] = useState<readonly string[]>(() => storedHidden ?? []);
  const [writeError, setWriteError] = useState<string | null>(null);
  // Write queue of one host and agent: the set the host last confirmed, the latest wanted set, and whether a
  // write is running. A host change under this hook drops the previous queue's wanted set ("Settings: workspace
  // host", WH9). Unmounting (another agent, leaving Settings) drops nothing: the queue finishes its latest set on
  // the service it was queued for, so ordinary navigation never loses the user's last selection.
  const queueRef = useRef<HiddenModelsQueue | null>(null);
  const queueFor = useCallback((): HiddenModelsQueue => {
    const existing = queueRef.current;
    if (existing?.service === providerSettingsService && existing.agentId === agentId) {
      return existing;
    }
    if (existing && existing.service !== providerSettingsService) existing.wanted = null;
    const queue: HiddenModelsQueue = {
      service: providerSettingsService,
      agentId,
      confirmed: storedHidden ?? [],
      wanted: null,
      writing: false,
    };
    queueRef.current = queue;
    return queue;
  }, [agentId, providerSettingsService, storedHidden]);

  // A catalog read (mount or reload) is the stored fact; it replaces the shown set unless a write is queued.
  useEffect(() => {
    const queue = queueFor();
    queue.confirmed = storedHidden ?? [];
    if (!queue.writing) setHidden(storedHidden ?? []);
  }, [queueFor, storedHidden]);

  const flush = useCallback(async (queue: HiddenModelsQueue) => {
    if (queue.writing) return;
    queue.writing = true;
    try {
      while (queue.wanted !== null) {
        const next = queue.wanted;
        queue.wanted = null;
        try {
          await queue.service.setAcpAgentHiddenModels({
            agentId: queue.agentId,
            hiddenModels: next,
          });
          queue.confirmed = next;
        } catch (error) {
          logger.warn("[AcpAgentCard] hidden models write failed", error);
          queue.wanted = null;
          // A replaced host's failure is not this host's: the shown set is the new host's.
          if (queueRef.current !== queue) return;
          setHidden(queue.confirmed);
          setWriteError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
    } finally {
      queue.writing = false;
    }
  }, []);

  const setHiddenModels = useCallback(
    (next: readonly string[]) => {
      setHidden(next);
      setWriteError(null);
      const queue = queueFor();
      queue.wanted = next;
      void flush(queue);
    },
    [flush, queueFor],
  );

  return { hidden, writeError, setHiddenModels };
}
