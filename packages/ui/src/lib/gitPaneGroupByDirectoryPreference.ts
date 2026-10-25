import {
  getBrowserLocalStorage,
  persistLocalBooleanPreference,
  readLocalBooleanPreference,
  type LocalBooleanPreferenceStorage,
} from "@/lib/localBooleanPreference.js";

// Separate from the chat card key so toggling one surface never changes the other.
export const GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY = "zcode-git-pane-group-by-directory";

export function readGitPaneGroupByDirectoryPreference(
  storage: LocalBooleanPreferenceStorage | null = getBrowserLocalStorage(),
): boolean {
  return readLocalBooleanPreference(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY, storage);
}

export function persistGitPaneGroupByDirectoryPreference(
  enabled: boolean,
  storage: LocalBooleanPreferenceStorage | null = getBrowserLocalStorage(),
): void {
  persistLocalBooleanPreference(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY, enabled, storage);
}
