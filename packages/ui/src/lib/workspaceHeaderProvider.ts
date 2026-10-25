import type { ZCodeProvider } from "@zcode/shared";

export function resolveWorkspaceHeaderProvider(
  activeTaskProvider: ZCodeProvider | null,
  selectedProvider: ZCodeProvider,
): ZCodeProvider {
  // When a task is open, the Header should show that task's provider.
  // Otherwise, after changing only the new-task provider, it may show the workspace-level choice instead of the current conversation context.
  return activeTaskProvider ?? selectedProvider;
}
