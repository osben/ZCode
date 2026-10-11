/**
 * StoreProvider — initializes the Zustand store and provides it through React Context.
 *
 * Mounted at the application root, it connects broadcastService for cross-window state synchronization.
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { IBroadcastService } from "@zcode/services";
import { createZCodeStore, type ZCodeStore, type ZCodeState } from "./index.js";

// Export Context so tests can inject a constructed store instance directly (for example, in cross-window broadcast suppression cases).
export const StoreContext = createContext<ZCodeStore | null>(null);

export function StoreProvider({
  broadcastService,
  initialIsRestoringOAuthSession = false,
  children,
}: {
  broadcastService: IBroadcastService;
  initialIsRestoringOAuthSession?: boolean;
  children: ReactNode;
}) {
  // Create the store only on the first render to avoid duplicate subscriptions during HMR.
  const storeRef = useRef<ZCodeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createZCodeStore(broadcastService, {
      initialIsRestoringOAuthSession,
    });
  }

  return <StoreContext.Provider value={storeRef.current}>{children}</StoreContext.Provider>;
}

/**
 * Hook for consuming the Zustand store.
 *
 * Usage:
 *   const theme = useZCodeStore(s => s.theme);
 *   const setTheme = useZCodeStore(s => s.setTheme);
 */
export function useZCodeStore<T>(selector: (state: ZCodeState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useZCodeStore 必须在 StoreProvider 内使用");
  }
  return useStore(store, selector);
}

/**
 * Fault-tolerant useZCodeStore variant with a default value (companion to decoupling components from the store).
 *
 * Use case: host components (PermissionDialog / Markdown dialogs, etc.) read
 * theme / codePreviewSettings from the store and pass them as props to presentational components. In unit tests, these hosts are often
 * rendered directly with renderToStaticMarkup without a Provider; return defaultValue instead of throwing,
 * consistent with the rule that "presentational components do not access the store." The real app Root always mounts StoreProvider and uses live values.
 *
 * Note: both the selector result and defaultValue must have stable references, or they may cause infinite rerenders.
 */
export function useZCodeStoreWithDefault<T>(
  selector: (state: ZCodeState) => T,
  defaultValue: T,
): T {
  const store = useContext(StoreContext);
  const subscribe = useCallback(
    (onStoreChange: () => void) => (store ? store.subscribe(onStoreChange) : () => {}),
    [store],
  );
  const getSnapshot = () => (store ? selector(store.getState()) : defaultValue);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
