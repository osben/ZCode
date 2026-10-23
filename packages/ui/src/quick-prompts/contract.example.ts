// Example wiring (documentation only, not compiled into the app).
// The composer owns the single read; the row and the "/" panel are both fed from it.
import type { QuickPromptBarProps } from "@/quick-prompts/index.js";
import { composeQuickPromptSlashItems, useQuickPrompts } from "@/quick-prompts/index.js";
import type { QuickPromptProjectRef } from "./contract.js";

export function useExampleComposerQuickPrompts(
  project: QuickPromptProjectRef | null,
  shared: Omit<QuickPromptBarProps, "snapshot" | "service" | "refresh" | "project">,
) {
  const quickPrompts = useQuickPrompts(project);
  // Pass the bar props to <QuickPromptBar {...barProps} /> in the composer render.
  const barProps: QuickPromptBarProps | null = quickPrompts.service
    ? {
        ...shared,
        project,
        snapshot: quickPrompts.snapshot,
        service: quickPrompts.service,
        refresh: quickPrompts.refresh,
      }
    : null;
  return { barProps, slashItems: composeQuickPromptSlashItems(quickPrompts.snapshot) };
}
