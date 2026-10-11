import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  acquireSessionsIndex,
  buildSessionsIndexEntryKey,
  releaseSessionsIndex,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import { logger } from "@/logger.js";

export interface WorkspaceSessionsIndexBinding {
  scope: SessionsIndexScope;
  agentService: SessionsIndexAgentService;
}

interface ActiveWorkspaceSessionsIndexEntry extends WorkspaceSessionsIndexBinding {
  store: SessionsIndexStore;
  unsubscribeStore: () => void;
}

function scopeLogKey(scope: SessionsIndexScope): string {
  return `${scope.endpointKey ?? "__base__"}:${scope.workspaceKey}`;
}

function isSameBinding(
  current: ActiveWorkspaceSessionsIndexEntry,
  next: WorkspaceSessionsIndexBinding,
): boolean {
  return (
    current.agentService === next.agentService &&
    current.scope.workspaceKey === next.scope.workspaceKey &&
    current.scope.workspacePath === next.scope.workspacePath &&
    current.scope.workspaceIdentity === next.scope.workspaceIdentity &&
    current.scope.endpointKey === next.scope.endpointKey
  );
}

/**
 * Hold sessions-index subscriptions by endpoint + workspaceKey.
 *
 * The old hook put the entire scopes array in one effect with cleanup; when a workspace was removed,
 * React released all sibling subscriptions before reacquiring the rest, replacing existing snapshots/watermarks with empty state.
 * Treat the scope array as a desired set here and apply side effects only for keys actually added/removed or with a changed endpoint.
 */
export class WorkspaceSessionsIndexSubscriptionSet {
  private readonly active = new Map<string, ActiveWorkspaceSessionsIndexEntry>();

  constructor(private readonly onStoreChange: () => void) {}

  reconcile(bindings: readonly WorkspaceSessionsIndexBinding[]): boolean {
    const desired = new Map<string, WorkspaceSessionsIndexBinding>();
    for (const binding of bindings) {
      desired.set(buildSessionsIndexEntryKey(binding.scope), binding);
    }

    let changed = false;
    const releasedScopeKeys: string[] = [];
    const acquiredScopeKeys: string[] = [];
    for (const [entryKey, current] of this.active) {
      const next = desired.get(entryKey);
      if (next && isSameBinding(current, next)) {
        continue;
      }
      if (
        next &&
        current.agentService !== next.agentService &&
        (current.scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !==
          LOCAL_SESSIONS_INDEX_ENDPOINT
      ) {
        // If the unique lease is released before a remote service replacement, the registry immediately closes the old store,
        // and the following acquire can only rebuild from an empty store. Acquire first so the registry can rebind transport in place while the old entry is alive,
        // without interrupting the projection or consumer listeners; then release the old lease.
        const store = acquireSessionsIndex(next.scope, next.agentService);
        const sameStore = store === current.store;
        const unsubscribeStore = sameStore
          ? current.unsubscribeStore
          : store.subscribe(this.onStoreChange);
        if (sameStore) {
          releaseSessionsIndex(current.scope, current.store);
        } else {
          this.disposeEntry(current);
        }
        this.active.set(entryKey, {
          ...next,
          store,
          unsubscribeStore,
        });
        releasedScopeKeys.push(scopeLogKey(current.scope));
        acquiredScopeKeys.push(scopeLogKey(next.scope));
        changed = true;
        continue;
      }
      releasedScopeKeys.push(scopeLogKey(current.scope));
      this.disposeEntry(current);
      this.active.delete(entryKey);
      changed = true;
    }

    for (const [entryKey, binding] of desired) {
      if (this.active.has(entryKey)) {
        continue;
      }
      const store = acquireSessionsIndex(binding.scope, binding.agentService);
      acquiredScopeKeys.push(scopeLogKey(binding.scope));
      this.active.set(entryKey, {
        ...binding,
        store,
        unsubscribeStore: store.subscribe(this.onStoreChange),
      });
      changed = true;
    }

    if (changed) {
      logger.info("[v4-sessions-index] workspace subscription set reconciled", {
        acquiredScopeKeys,
        releasedScopeKeys,
        activeCount: this.active.size,
      });
      this.onStoreChange();
    } else {
      logger.debug("[v4-sessions-index] workspace subscription set unchanged", {
        activeCount: this.active.size,
      });
    }
    return changed;
  }

  getStore(
    scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  ): SessionsIndexStore | undefined {
    return this.active.get(buildSessionsIndexEntryKey(scope))?.store;
  }

  size(): number {
    return this.active.size;
  }

  /** Release everything when the hook truly unmounts (including StrictMode cleanup); later reconciliation can establish them again. */
  dispose(): void {
    if (this.active.size > 0) {
      logger.info("[v4-sessions-index] workspace subscription set disposed", {
        releasedScopeKeys: [...this.active.values()].map((entry) => scopeLogKey(entry.scope)),
      });
    }
    for (const entry of this.active.values()) {
      this.disposeEntry(entry);
    }
    this.active.clear();
  }

  private disposeEntry(entry: ActiveWorkspaceSessionsIndexEntry): void {
    entry.unsubscribeStore();
    releaseSessionsIndex(entry.scope, entry.store);
  }
}
