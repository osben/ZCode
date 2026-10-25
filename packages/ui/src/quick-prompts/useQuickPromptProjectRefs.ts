import { useEffect, useRef, useState } from "react";
import { QUICK_PROMPTS_CHANGED_CHANNEL, type QuickPromptProjectRef } from "./contract.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export interface QuickPromptProjectRefsState {
  /** Projects that own at least one quick prompt (rule 19). Empty until the first read completes. */
  refs: readonly QuickPromptProjectRef[];
  error: unknown | null;
}

const EMPTY_STATE: QuickPromptProjectRefsState = { refs: [], error: null };

/**
 * Settings needs projects that are no longer in the project tree but still own quick prompts. The read follows the
 * same rules as useQuickPrompts: every committed write re-reads, and a response older than the latest request is
 * dropped.
 */
export function useQuickPromptProjectRefs(): QuickPromptProjectRefsState {
  const services = useOptionalBaseWorkspaceServices();
  const service = services?.quickPromptService ?? null;
  const broadcastService = services?.broadcastService ?? null;
  const [state, setState] = useState<QuickPromptProjectRefsState | null>(null);
  const serialRef = useRef(0);

  useEffect(() => {
    if (!service) return;
    const load = async () => {
      const request = ++serialRef.current;
      try {
        const refs = await service.readProjects();
        if (request === serialRef.current) setState({ refs, error: null });
      } catch (error: unknown) {
        if (request === serialRef.current) setState({ refs: [], error });
      }
    };
    void load();
    const subscription = broadcastService?.onMessage((event) => {
      if (event.channel === QUICK_PROMPTS_CHANGED_CHANNEL) void load();
    });
    return () => {
      // Responses still in flight belong to a service that is no longer mounted.
      serialRef.current++;
      subscription?.dispose();
    };
  }, [service, broadcastService]);

  return state ?? EMPTY_STATE;
}
