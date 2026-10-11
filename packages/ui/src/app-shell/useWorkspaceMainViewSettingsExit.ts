import { useCallback, useLayoutEffect, useRef } from "react";
import type { WorkspaceMainView } from "@/app-shell/types.js";

export function useWorkspaceMainViewSettingsExit({
  isWorkspaceVisible,
  workspaceMainView,
  onExitSettings,
}: {
  isWorkspaceVisible: boolean;
  workspaceMainView: WorkspaceMainView;
  onExitSettings: () => void;
}) {
  const wasWorkspaceVisibleRef = useRef(isWorkspaceVisible);
  const settingsEntryMainViewRef = useRef(workspaceMainView);
  const preserveNextSettingsExitRef = useRef(false);

  const preserveNextSettingsExit = useCallback(() => {
    if (!wasWorkspaceVisibleRef.current) {
      preserveNextSettingsExitRef.current = true;
    }
  }, []);

  useLayoutEffect(() => {
    const wasWorkspaceVisible = wasWorkspaceVisibleRef.current;
    wasWorkspaceVisibleRef.current = isWorkspaceVisible;

    if (wasWorkspaceVisible && !isWorkspaceVisible) {
      settingsEntryMainViewRef.current = workspaceMainView;
      preserveNextSettingsExitRef.current = false;
      return;
    }

    if (!wasWorkspaceVisible && isWorkspaceVisible) {
      if (preserveNextSettingsExitRef.current) {
        // If the plugin marketplace is already open, clicking “New” again from settings leaves the main-view value as
        // plugin-store, so the before/after values alone cannot recognize explicit navigation. Consume this one-time marker
        // to keep the settings-exit flow from closing the marketplace incorrectly; the marker can be written only while the settings layer is open.
        preserveNextSettingsExitRef.current = false;
        return;
      }

      if (workspaceMainView === settingsEntryMainViewRef.current) {
        // Settings only overlays the workspace and does not unmount the underlying App, so the Automations main view from before entry
        // remains active. Always return to conversation when leaving settings,
        // giving Back, plugin prompts, Skill creation, and settings shortcuts the same navigation semantics.
        onExitSettings();
      }
    }
  }, [isWorkspaceVisible, onExitSettings, workspaceMainView]);

  return { preserveNextSettingsExit };
}
