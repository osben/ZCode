import {
  getBrowserLocalStorage,
  persistLocalBooleanPreference,
  readLocalBooleanPreference,
  type LocalBooleanPreferenceStorage,
} from "@/lib/localBooleanPreference.js";

export const CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY = "zcode-change-summary-tree-view";

export function readChangeSummaryTreeViewPreference(
  storage: LocalBooleanPreferenceStorage | null = getBrowserLocalStorage(),
): boolean {
  return readLocalBooleanPreference(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY, storage);
}

export function persistChangeSummaryTreeViewPreference(
  enabled: boolean,
  storage: LocalBooleanPreferenceStorage | null = getBrowserLocalStorage(),
): void {
  persistLocalBooleanPreference(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY, enabled, storage);
}
