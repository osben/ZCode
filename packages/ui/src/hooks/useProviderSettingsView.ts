import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  getProviderSettingsSnapshot,
  reloadProviderSettingsSnapshot,
  subscribeProviderSettingsSnapshot,
  type ProviderSettingsState,
} from "@/lib/providerSettingsSnapshot.js";

export interface ProviderSettingsRead {
  state: ProviderSettingsState;
  reload(): void;
}

export interface ProviderSettingsServiceRead extends ProviderSettingsRead {
  /** The authoritative View returned by the mutation; UI convergence does not depend on an asynchronous onDidChange event. */
  commit(view: ProviderSettingsView): void;
}

export function useProviderSettingsView(): ProviderSettingsRead {
  const state = useSyncExternalStore(
    subscribeProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
  );
  return {
    state,
    reload: useCallback(() => {
      void reloadProviderSettingsSnapshot().catch((error) => {
        logger.warn("[ProviderSettings] 重试加载根 Environment 失败", { error });
      });
    }, []),
  };
}

interface OwnedProviderSettingsState {
  service: IProviderSettingsService;
  state: ProviderSettingsState;
}

/** Read the target Environment for the current ServiceProvider in the Settings editor, exposing errors and retry explicitly. */
export function useProviderSettingsServiceView(
  service: IProviderSettingsService,
): ProviderSettingsServiceRead {
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedProviderSettingsState>({
    service,
    state: { status: "loading" },
  });
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const generationRef = useRef(0);
  const latestRevisionRef = useRef(-1);
  const visibleState = owned.service === service ? owned.state : ({ status: "loading" } as const);

  const commitView = useCallback(
    (view: ProviderSettingsView): boolean => {
      // When a remote workspace attachment changes, an old mutation may return after the new Service.
      // Only allow the latest revision from the current Service to commit, preventing an old Environment
      // from writing into the new page.
      if (serviceRef.current !== service || ownedRef.current.service !== service) {
        return false;
      }
      const current = ownedRef.current.state;
      const currentRevision = current.status === "ready" ? current.view.revision : -1;
      const latestRevision = Math.max(currentRevision, latestRevisionRef.current);
      if (view.revision < latestRevision) {
        return false;
      }
      // An event and mutation response with the same revision represent the same Registry fact;
      // avoid rendering twice.
      if (view.revision === latestRevision && current.status === "ready") {
        return false;
      }
      latestRevisionRef.current = view.revision;
      setOwned({ service, state: { status: "ready", view } });
      return true;
    },
    [service],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const retainedReady =
      previous.service === service && previous.state.status === "ready" ? previous.state : null;
    setOwned({ service, state: retainedReady ?? { status: "loading" } });
    latestRevisionRef.current = retainedReady?.view.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    const commit = (view: ProviderSettingsView): void => {
      if (generation !== generationRef.current) return;
      if (commitView(view)) {
        hasReadyView = true;
      }
    };
    const subscription = service.onDidChange(commit);
    void service.getView().then(commit, (cause) => {
      if (generation !== generationRef.current) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.warn("[ProviderSettings] 加载目标 Environment 失败", { error });
      if (!hasReadyView) setOwned({ service, state: { status: "error", error } });
    });
    return () => {
      generationRef.current += 1;
      subscription.dispose();
    };
  }, [commitView, reloadVersion, service]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    commit: useCallback(
      (view: ProviderSettingsView) => {
        commitView(view);
      },
      [commitView],
    ),
  };
}
