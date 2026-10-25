// Remember the top-level tab for the Automations page in sessionStorage,
// following the last-section precedent in settingsNavigation.ts so returning from a detail page/conversation restores “Workflows.”
// After the hub became a cross-project view, the page no longer depends on the active project: use one app-level key instead of bucketing by workspaceKey.
// Do not store this in Zustand or broadcast it across windows.
import type { AutomationsPageTab } from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";

const STORAGE_KEY = "zcode-automations-page-tab";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readAutomationsPageTab(): AutomationsPageTab {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return value === "workflow" ? "workflow" : "automation";
  } catch {
    return "automation";
  }
}

export function writeAutomationsPageTab(tab: AutomationsPageTab): void {
  try {
    storage()?.setItem(STORAGE_KEY, tab);
  } catch {
    // If sessionStorage is unavailable (private mode/quota), do not remember the tab; next time use the default without affecting functionality.
  }
}
