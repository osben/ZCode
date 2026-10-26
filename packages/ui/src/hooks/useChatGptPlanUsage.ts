// ChatGPT plan usage per account for the composer chip and model picker (specs/chatgpt-plan-signin.md "Usage across
// the app"). One store per oauth service instance, so every surface shares the subscription and refresh cadence.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createChatGptPlanUsageStore,
  type ChatGptPlanUsageMap,
  type ChatGptPlanUsageSource,
  type ChatGptPlanUsageStore,
} from "@/lib/chatGptPlanUsageStore.js";
import { useOptionalServices } from "@/hooks/useServices.js";

/** Countdown re-render cadence (display only, never a probe). */
const CLOCK_TICK_MS = 30_000;
const EMPTY: ChatGptPlanUsageMap = new Map();
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

const stores = new WeakMap<object, ChatGptPlanUsageStore>();

function storeFor(source: ChatGptPlanUsageSource): ChatGptPlanUsageStore {
  let store = stores.get(source);
  if (!store) {
    store = createChatGptPlanUsageStore(source);
    stores.set(source, store);
  }
  return store;
}

/**
 * Usage per ChatGPT plan account and a display clock. `enabled` false (no ChatGPT plan surface on screen) keeps
 * the store unsubscribed, so no refresh runs for users without a ChatGPT plan.
 */
export function useChatGptPlanUsage(enabled: boolean): {
  usage: ChatGptPlanUsageMap;
  nowMs: number;
} {
  // Optional: the composer also renders outside a ServiceProvider (isolated tests, share views); it then has no usage.
  const oauthService = useOptionalServices()?.oauthService;
  const store = oauthService ? storeFor(oauthService as unknown as ChatGptPlanUsageSource) : null;
  const active = enabled && store !== null;
  const usage = useSyncExternalStore(
    active ? store.subscribe : noopSubscribe,
    active ? store.getSnapshot : emptySnapshot,
    active ? store.getSnapshot : emptySnapshot,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [active, usage]);
  return { usage, nowMs };
}
