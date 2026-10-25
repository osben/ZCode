import { useMemo } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import {
  type IQuickPromptService,
  type QuickPrompt,
  type QuickPromptProjectRef,
  type QuickPromptScope,
} from "./contract.js";
import { quickPromptErrorMessageId } from "@/quick-prompts/model.js";

export interface QuickPromptSettingsActions {
  setPinned(prompt: QuickPrompt, pinned: boolean): Promise<void>;
  setHidden(prompt: QuickPrompt, project: QuickPromptProjectRef, hidden: boolean): Promise<void>;
  duplicate(prompt: QuickPrompt): Promise<void>;
  remove(prompt: QuickPrompt): Promise<void>;
  reorder(
    scope: QuickPromptScope,
    project: QuickPromptProjectRef | null,
    orderedIds: string[],
  ): Promise<void>;
}

/**
 * Settings row actions. Each action runs one service call, shows a localized toast when it fails (the raw code is
 * never shown), and re-reads the list. The database is the only truth, so nothing here keeps a local copy.
 */
export function useQuickPromptSettingsActions(params: {
  service: IQuickPromptService | null;
  refresh: () => Promise<void>;
}): QuickPromptSettingsActions {
  const { intl } = useZCodeIntl();
  const { service, refresh } = params;

  return useMemo(() => {
    const run = async (
      label: string,
      operation: (quickPrompts: IQuickPromptService) => Promise<unknown>,
    ) => {
      if (!service) return;
      try {
        await operation(service);
      } catch (cause) {
        // Names and bodies never reach the log; the error carries only the stable code.
        logger.warn(`[quick-prompts] settings ${label} failed`, cause);
        toast(intl.formatMessage({ id: quickPromptErrorMessageId(cause) }), {
          durationMs: 8_000,
        });
      } finally {
        await refresh();
      }
    };

    return {
      setPinned: (prompt, pinned) =>
        run("pin", (quickPrompts) => quickPrompts.setPinned({ promptId: prompt.promptId, pinned })),
      setHidden: (prompt, project, hidden) =>
        run("hide", (quickPrompts) =>
          quickPrompts.setHidden({ promptId: prompt.promptId, project, hidden }),
        ),
      duplicate: (prompt) =>
        run("duplicate", (quickPrompts) =>
          quickPrompts.duplicate({
            promptId: prompt.promptId,
            scope: prompt.scope,
            project: prompt.project,
          }),
        ),
      remove: async (prompt) => {
        const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
          title: intl.formatMessage({
            id:
              prompt.scope === "global"
                ? "quickPrompts.confirm.deleteEverywhere.title"
                : "quickPrompts.confirm.delete.title",
          }),
          description: intl.formatMessage({
            id:
              prompt.scope === "global"
                ? "quickPrompts.confirm.deleteEverywhere.description"
                : "quickPrompts.confirm.delete.description",
          }),
          confirmLabel: intl.formatMessage({ id: "quickPrompts.confirm.delete" }),
          confirmVariant: "destructive",
        });
        if (!confirmed) return;
        await run("delete", (quickPrompts) => quickPrompts.delete({ promptId: prompt.promptId }));
      },
      reorder: (scope, project, orderedIds) =>
        run("reorder", (quickPrompts) => quickPrompts.reorder({ scope, project, orderedIds })),
    };
  }, [intl, refresh, service]);
}
