import { useCallback } from "react";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

/** Opens Settings on the Voice dictation section; a no-op where no tab store is mounted (tests, bare embeds). */
export function useOpenVoiceDictationSettings(): () => void {
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  return useCallback(() => {
    setPendingSettingsSectionIntent("voiceDictation");
    openSettingsTab?.();
  }, [openSettingsTab]);
}
