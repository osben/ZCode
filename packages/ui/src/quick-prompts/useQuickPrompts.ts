import { useCallback, useEffect, useMemo, useState } from "react";
import {
  QUICK_PROMPTS_CHANGED_CHANNEL,
  type IQuickPromptService,
  type QuickPromptProjectRef,
  type QuickPromptSnapshot,
} from "./contract.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  createQuickPromptReader,
  parseQuickPromptProjectKey,
  quickPromptProjectKey,
  type QuickPromptReadResult,
} from "@/quick-prompts/reader.js";

export interface QuickPromptsState {
  /** Null while the first read of this project is in flight, or when no quick prompt service is wired. */
  snapshot: QuickPromptSnapshot | null;
  /** The last read failed for this project (the cause is logged, never shown raw). Null otherwise. */
  error: unknown | null;
  /** Controller-owned service for mutations. Mutations re-read through the broadcast; callers may also refresh. */
  service: IQuickPromptService | null;
  refresh: () => Promise<void>;
}

/**
 * Controller-owned quick prompt read for one project (null = globals only). Subscribes once per project and
 * re-reads on every committed write. Results for a previous project are never shown.
 */
export function useQuickPrompts(project: QuickPromptProjectRef | null): QuickPromptsState {
  // Optional accessor: composers rendered without a ServiceProvider (tests, embedded panes) get no quick prompts
  // instead of throwing.
  const services = useOptionalBaseWorkspaceServices();
  const service = services?.quickPromptService ?? null;
  const broadcastService = services?.broadcastService ?? null;
  const projectKey = quickPromptProjectKey(project);
  const stableProject = useMemo(() => parseQuickPromptProjectKey(projectKey), [projectKey]);
  const [result, setResult] = useState<QuickPromptReadResult | null>(null);
  const reader = useMemo(
    () =>
      service
        ? createQuickPromptReader({
            read: (next) => service.read({ project: next }),
            publish: setResult,
          })
        : null,
    [service],
  );

  useEffect(() => {
    if (!reader || !broadcastService) return;
    void reader.load(stableProject);
    const subscription = broadcastService.onMessage((event) => {
      if (event.channel === QUICK_PROMPTS_CHANGED_CHANNEL) void reader.load(stableProject);
    });
    return () => {
      reader.invalidate();
      subscription.dispose();
    };
  }, [broadcastService, reader, stableProject]);

  useEffect(() => {
    if (result && "error" in result) {
      // The cause is a service error; names and bodies never reach the log.
      logger.warn("[quick-prompts] 读取快捷提示失败", result.error);
    }
  }, [result]);

  const refresh = useCallback(async () => {
    await reader?.load(stableProject);
  }, [reader, stableProject]);

  const matching = result && result.projectKey === projectKey ? result : null;
  const current = matching && "snapshot" in matching ? matching.snapshot : null;
  const error = matching && "error" in matching ? matching.error : null;
  return { snapshot: current, error, service, refresh };
}
