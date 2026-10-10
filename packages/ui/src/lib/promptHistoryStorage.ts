import { MAX_PROMPT_HISTORY } from "@/lib/promptHistory.js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PROMPT_HISTORY_STORAGE_KEY_PREFIX = "zcode-chat-prompt-history:";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getPromptHistoryStorageKey(workspacePath: string) {
  return `${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${workspacePath}`;
}

function normalizePromptHistoryEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

export function readPromptHistoryEntries(
  workspacePath: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  const rawValue = storage?.getItem(getPromptHistoryStorageKey(workspacePath));
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizePromptHistoryEntries(parsed);
  } catch {
    return [];
  }
}

export function persistPromptHistoryEntries(
  workspacePath: string,
  entries: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
) {
  const normalizedEntries = normalizePromptHistoryEntries(entries);

  // Previously, chat input history lived only in ChatView memory and was lost on page refresh or window restart,
  // so users could not retrieve recent messages with the Up key. Store it in localStorage per workspace instead,
  // preserving history across restarts without mixing prompts between projects.
  storage?.setItem(getPromptHistoryStorageKey(workspacePath), JSON.stringify(normalizedEntries));
}
