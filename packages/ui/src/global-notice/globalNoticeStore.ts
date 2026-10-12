import { logger } from "@/logger.js";

export type GlobalNoticePriority = "low" | "normal" | "high";
export type GlobalNoticeInterruptPolicy = "passive" | "replace-lower-priority";

export interface GlobalNoticeEnvelope {
  noticeId: string;
  dedupeKey: string;
  type: string;
  schemaVersion: number;
  scope: "user" | "workspace" | "task";
  priority: GlobalNoticePriority;
  interruptPolicy: GlobalNoticeInterruptPolicy;
  createdAt: number;
  expiresAt?: number;
  payload: Record<string, unknown>;
  actions: Array<{ id: string; label: string }>;
  dismissPolicy: { kind: "none" } | { kind: "cooldown"; cooldownMs: number };
  persistencePolicy: "memory" | "latest-only";
  source: string;
  revision: number;
}

interface PersistedGlobalNoticeState {
  version: 1;
  latest: GlobalNoticeEnvelope | null;
  dismissedUntilByKey: Record<string, number>;
  requiresPublishAfterDismissalByKey: Record<string, boolean>;
}

export interface GlobalNoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GlobalNoticeStore {
  publish(notice: GlobalNoticeEnvelope): void;
  dismiss(noticeId: string): void;
  getVisible(): GlobalNoticeEnvelope | null;
  getSnapshot(): PersistedGlobalNoticeState;
  subscribe(listener: () => void): () => void;
}

const STORAGE_KEY = "zcode:global-notice:v1";

function emptyState(): PersistedGlobalNoticeState {
  return {
    version: 1,
    latest: null,
    dismissedUntilByKey: {},
    requiresPublishAfterDismissalByKey: {},
  };
}

function isLegacyHighspeedMockNotice(notice: GlobalNoticeEnvelope | null): boolean {
  if (notice?.type !== "highspeed-share") return false;
  const cardId = notice.payload.cardId;
  return typeof cardId === "string" && cardId.startsWith("hsc_mock_");
}

function readState(
  storage: GlobalNoticeStorage,
  onPersistError?: (error: unknown) => void,
): PersistedGlobalNoticeState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<PersistedGlobalNoticeState>;
    if (parsed.version !== 1) return emptyState();
    const state: PersistedGlobalNoticeState = {
      version: 1,
      latest: parsed.latest ?? null,
      dismissedUntilByKey: parsed.dismissedUntilByKey ?? {},
      requiresPublishAfterDismissalByKey: parsed.requiresPublishAfterDismissalByKey ?? {},
    };
    if (!isLegacyHighspeedMockNotice(state.latest)) return state;

    // Bug root cause: early Highspeed mock notices used latest-only persistence, so restarting
    // after the mock was dismissed still restored fake share data.
    const cleaned = { ...state, latest: null };
    // A failed cleanup write must not reset the whole state (including 24h cooldowns) to empty:
    // keep using cleaned as the in-memory state.
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    } catch (error) {
      onPersistError?.(error);
    }
    return cleaned;
  } catch {
    return emptyState();
  }
}

export function createGlobalNoticeStore(options: {
  storage: GlobalNoticeStorage;
  now?: () => number;
  /** Controlled callback for persistence failures (QuotaExceeded, storage disabled); silent by default, the browser entry wires it to logger.warn. */
  onPersistError?: (error: unknown) => void;
}): GlobalNoticeStore {
  const now = options.now ?? Date.now;
  let state = readState(options.storage, options.onPersistError);
  const listeners = new Set<() => void>();

  const persist = () => {
    // Bug root cause: a throwing setItem would make publish/dismiss throw, so subscribers would
    // never see the updated in-memory state. The caller (SessionPane auto-share) claims first and
    // then publishes, so the error would leave a non-retryable claim: the user sees no share card
    // and it cannot be recovered within the current Renderer lifetime. Persistence is only a
    // display enhancement: update the in-memory state first, write to storage best-effort, and
    // notify subscribers regardless of success (spec §6).
    try {
      options.storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      options.onPersistError?.(error);
    }
    for (const listener of listeners) listener();
  };

  return {
    publish(notice) {
      const dismissedUntil = state.dismissedUntilByKey[notice.dedupeKey] ?? 0;
      state = {
        ...state,
        latest: notice.persistencePolicy === "latest-only" ? notice : state.latest,
        requiresPublishAfterDismissalByKey: {
          ...state.requiresPublishAfterDismissalByKey,
          [notice.dedupeKey]: dismissedUntil > now(),
        },
      };
      persist();
    },
    dismiss(noticeId) {
      const latest = state.latest;
      if (!latest || latest.noticeId !== noticeId) return;
      const cooldownMs =
        latest.dismissPolicy.kind === "cooldown" ? latest.dismissPolicy.cooldownMs : 0;
      state = {
        ...state,
        dismissedUntilByKey: {
          ...state.dismissedUntilByKey,
          [latest.dedupeKey]: now() + cooldownMs,
        },
        requiresPublishAfterDismissalByKey: {
          ...state.requiresPublishAfterDismissalByKey,
          [latest.dedupeKey]: true,
        },
      };
      persist();
    },
    getVisible() {
      const latest = state.latest;
      if (!latest) return null;
      const current = now();
      if (latest.expiresAt !== undefined && latest.expiresAt <= current) return null;
      if ((state.dismissedUntilByKey[latest.dedupeKey] ?? 0) > current) return null;
      if (state.requiresPublishAfterDismissalByKey[latest.dedupeKey]) return null;
      return latest;
    },
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createMemoryNoticeStorage(): GlobalNoticeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Accessing localStorage in private mode, when disabled, or inside a sandboxed iframe throws SecurityError; fall back to in-memory storage so notices remain usable for this session. */
function resolveBrowserNoticeStorage(): GlobalNoticeStorage {
  try {
    const storage = window.localStorage;
    if (storage) return storage;
  } catch (error) {
    logger.warn("[global-notice] localStorage 不可用，改用内存存储", {
      error: describeError(error),
    });
  }
  return createMemoryNoticeStorage();
}

export const browserGlobalNoticeStore =
  typeof window === "undefined"
    ? null
    : createGlobalNoticeStore({
        storage: resolveBrowserNoticeStorage(),
        onPersistError: (error) =>
          logger.warn("[global-notice] 通知持久化失败，仅保留内存态", {
            error: describeError(error),
          }),
      });
