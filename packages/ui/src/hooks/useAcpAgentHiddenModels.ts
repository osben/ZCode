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
  // Write queue state: the set the host last confirmed, the latest wanted set, and whether a write is running.
  const confirmedRef = useRef<readonly string[]>(storedHidden ?? []);
  const wantedRef = useRef<readonly string[] | null>(null);
  const writingRef = useRef(false);

  // A catalog read (mount or reload) is the stored fact; it replaces the shown set unless a write is queued.
  useEffect(() => {
    confirmedRef.current = storedHidden ?? [];
    if (!writingRef.current) setHidden(storedHidden ?? []);
  }, [storedHidden]);

  const flush = useCallback(async () => {
    if (writingRef.current) return;
    writingRef.current = true;
    try {
      while (wantedRef.current !== null) {
        const next = wantedRef.current;
        wantedRef.current = null;
        try {
          await providerSettingsService.setAcpAgentHiddenModels({
            agentId,
            hiddenModels: next,
          });
          confirmedRef.current = next;
        } catch (error) {
          logger.warn("[AcpAgentCard] hidden models write failed", error);
          wantedRef.current = null;
          setHidden(confirmedRef.current);
          setWriteError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
    } finally {
      writingRef.current = false;
    }
  }, [agentId, providerSettingsService]);

  const setHiddenModels = useCallback(
    (next: readonly string[]) => {
      setHidden(next);
      setWriteError(null);
      wantedRef.current = next;
      void flush();
    },
    [flush],
  );

  return { hidden, writeError, setHiddenModels };
}
