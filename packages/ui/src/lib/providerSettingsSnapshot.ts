import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";

type ProviderSettingsSnapshotListener = () => void;

export type ProviderSettingsState =
  | { status: "loading" }
  | { status: "ready"; view: ProviderSettingsView }
  | { status: "error"; error: Error };

let snapshot: ProviderSettingsState = { status: "loading" };
let connectionGeneration = 0;
let activeReload: (() => Promise<void>) | null = null;
const listeners = new Set<ProviderSettingsSnapshotListener>();

export interface ProviderSettingsSnapshotConnection {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  dispose(): void;
}

export function getProviderSettingsSnapshot(): ProviderSettingsState {
  return snapshot;
}

export function subscribeProviderSettingsSnapshot(
  listener: ProviderSettingsSnapshotListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reloadProviderSettingsSnapshot(): Promise<void> {
  return activeReload?.() ?? Promise.reject(new Error("Provider Settings Service 尚未连接"));
}

export function connectProviderSettingsSnapshot(
  service: IProviderSettingsService,
): ProviderSettingsSnapshotConnection {
  connectionGeneration += 1;
  const generation = connectionGeneration;
  snapshot = { status: "loading" };
  publish();

  const commit = (view: ProviderSettingsView): void => {
    if (generation !== connectionGeneration) return;
    if (snapshot.status === "ready" && view.revision < snapshot.view.revision) return;
    if (snapshot.status === "ready" && snapshot.view.revision === view.revision) return;
    snapshot = { status: "ready", view };
    publish();
  };

  const read = async (): Promise<void> => {
    try {
      commit(await service.getView());
    } catch (cause) {
      if (generation !== connectionGeneration) throw cause;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // Keep the Last Known Good snapshot when one exists; only an initial failure enters the retryable error state.
      if (snapshot.status !== "ready") {
        snapshot = { status: "error", error };
        publish();
      }
      throw error;
    }
  };

  // Subscribe before reading to avoid missing an event between getView and a Registry update.
  const subscription = service.onDidChange(commit);
  const ready = read();
  activeReload = read;

  return {
    ready,
    reload: read,
    dispose() {
      subscription.dispose();
      if (generation === connectionGeneration) activeReload = null;
    },
  };
}

export function resetProviderSettingsSnapshotForTest(): void {
  connectionGeneration += 1;
  snapshot = { status: "loading" };
  activeReload = null;
  listeners.clear();
}

function publish(): void {
  for (const listener of listeners) listener();
}
