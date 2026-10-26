/**
 * Renderer cache of ChatGPT plan usage per account (specs/chatgpt-plan-signin.md "Usage across the app"). The
 * host owns the snapshots and pushes changes; this store only mirrors them for the composer chip and the model
 * picker, and drives the refresh cadence while at least one surface is subscribed.
 */
import type {
  SiwcPlanAccountsStatus,
  SiwcPlanUsageChange,
  SiwcPlanUsageSnapshot,
} from "@zcode/shared";

export const CHATGPT_PLAN_USAGE_REFRESH_MS = 60_000;

/** The oauth service surface the store needs; members are optional because remote/web hosts may lack them. */
export interface ChatGptPlanUsageSource {
  getChatGptPlanStatus?: () => Promise<SiwcPlanAccountsStatus>;
  refreshChatGptPlanUsage?: () => Promise<SiwcPlanAccountsStatus>;
  onDidChangeChatGptPlanUsage?: (listener: (change: SiwcPlanUsageChange) => void) => {
    dispose(): void;
  };
}

export type ChatGptPlanUsageMap = ReadonlyMap<string, SiwcPlanUsageSnapshot>;

export interface ChatGptPlanUsageStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ChatGptPlanUsageMap;
}

interface StoreTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  addFocusListener(handler: () => void): () => void;
}

const browserTimers: StoreTimers = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  addFocusListener: (handler) => {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  },
};

function usageMapOf(status: SiwcPlanAccountsStatus): Map<string, SiwcPlanUsageSnapshot> {
  const map = new Map<string, SiwcPlanUsageSnapshot>();
  for (const account of status.accounts ?? []) {
    if (account.usage) map.set(account.accountKey, account.usage);
  }
  return map;
}

export function createChatGptPlanUsageStore(
  source: ChatGptPlanUsageSource,
  timers: StoreTimers = browserTimers,
): ChatGptPlanUsageStore {
  let snapshot: ChatGptPlanUsageMap = new Map();
  const listeners = new Set<() => void>();
  // Only the newest read writes. Events that arrive while a read is in flight are logged and re-applied on top
  // of its result, so an older read never undoes an account an event already changed (S6).
  let sequence = 0;
  let readsInFlight = 0;
  let eventLog: SiwcPlanUsageChange[] = [];
  let stop: (() => void) | null = null;

  const publish = (next: ChatGptPlanUsageMap) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const apply = (map: Map<string, SiwcPlanUsageSnapshot>, change: SiwcPlanUsageChange) => {
    if (change.usage) map.set(change.accountKey, change.usage);
    else map.delete(change.accountKey);
  };

  const read = async (load: (() => Promise<SiwcPlanAccountsStatus>) | undefined) => {
    if (!load) return;
    const started = ++sequence;
    const eventsBefore = eventLog.length;
    readsInFlight += 1;
    try {
      const status = await load();
      if (started === sequence && stop) {
        const next = usageMapOf(status);
        for (const change of eventLog.slice(eventsBefore)) apply(next, change);
        publish(next);
      }
    } catch {
      // Usage is display-only; a failed read keeps what is shown.
    } finally {
      readsInFlight -= 1;
      if (readsInFlight === 0) eventLog = [];
    }
  };
  const refresh = () => void read(source.refreshChatGptPlanUsage?.bind(source));

  const start = () => {
    let subscription: { dispose(): void } | undefined;
    try {
      subscription = source.onDidChangeChatGptPlanUsage?.((change) => {
        if (readsInFlight > 0) eventLog.push(change);
        const next = new Map(snapshot);
        apply(next, change);
        publish(next);
      });
    } catch {
      subscription = undefined;
    }
    const interval = timers.setInterval(refresh, CHATGPT_PLAN_USAGE_REFRESH_MS);
    const removeFocus = timers.addFocusListener(refresh);
    stop = () => {
      subscription?.dispose();
      timers.clearInterval(interval);
      removeFocus();
    };
    void read(source.getChatGptPlanStatus?.bind(source)).then(refresh);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          // S8: the last surface leaving stops the timers and the event subscription.
          stop?.();
          stop = null;
        }
      };
    },
    getSnapshot: () => snapshot,
  };
}
