import { ProviderConfigMap } from "./config/index.js";
import type { AccountProviderStates } from "./account-provider-state.js";
import {
  createFailClosedAccountProviderConfigSnapshot,
  createAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "./sources.js";

export interface AccountProviderResolveInput {
  readonly configRevision: string;
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly previousStates?: AccountProviderStates;
  readonly reasons?: readonly string[];
}

export type AccountProviderResolver = (
  input: AccountProviderResolveInput,
) => Promise<{ readonly providers: ProviderConfigMap; readonly states: AccountProviderStates }>;

export interface AccountProviderServiceDependencies {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly resolve: AccountProviderResolver;
}

export interface AccountProviderServiceRefreshErrorEvent {
  readonly error: unknown;
  readonly reasons: readonly string[];
}

interface RefreshWaiter {
  readonly generation: number;
  readonly resolve: (snapshot: AccountProviderConfigSnapshot) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Maintains the third-layer Provider Config Overlay projected from current account state.
 *
 * This service only coordinates the Config Source, refresh, and last-known-good publication; concrete queries for login, entitlements, and team connections
 * are injected by an outer Resolver, so this package does not depend on file, network, or OAuth implementations.
 */
export class AccountProviderService implements ProviderSource<AccountProviderConfigSnapshot> {
  readonly #configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly #resolve: AccountProviderResolver;
  readonly #changeListeners = new Set<(reason: string) => void>();
  readonly #errorListeners = new Set<(event: AccountProviderServiceRefreshErrorEvent) => void>();
  readonly #pendingReasons = new Set<string>();
  #configDispose: (() => void) | null = null;
  #snapshot: AccountProviderConfigSnapshot | null = null;
  #refreshInFlight: Promise<AccountProviderConfigSnapshot> | null = null;
  #requestedGeneration = 0;
  readonly #refreshWaiters: RefreshWaiter[] = [];
  #started = false;
  #disposed = false;

  constructor(dependencies: AccountProviderServiceDependencies) {
    this.#configSource = dependencies.configSource;
    this.#resolve = dependencies.resolve;
  }

  async read(): Promise<AccountProviderConfigSnapshot> {
    this.#assertNotDisposed();
    this.#ensureStarted();
    if (this.#snapshot) return this.#snapshot;
    // Concurrent initial reads are not new account facts; do not queue a second refresh that overwrites the initial fail-closed startup result.
    if (this.#refreshInFlight) return this.#refreshInFlight;
    return this.#requestRefresh("start");
  }

  refresh(reason = "explicit"): Promise<AccountProviderConfigSnapshot> {
    this.#assertNotDisposed();
    this.#ensureStarted();
    return this.#requestRefresh(reason);
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onDidRefreshError(
    listener: (event: AccountProviderServiceRefreshErrorEvent) => void,
  ): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#configDispose?.();
    this.#configDispose = null;
    const error = new Error("AccountProviderService 已 dispose");
    for (const waiter of this.#refreshWaiters.splice(0)) waiter.reject(error);
    this.#changeListeners.clear();
    this.#errorListeners.clear();
  }

  #ensureStarted(): void {
    if (this.#started) return;
    this.#started = true;
    this.#configDispose = this.#configSource.onDidChange((reason) => {
      void this.#requestRefresh(`config:${reason || "changed"}`).catch(() => {
        // Source-driven background failures are reported through onDidRefreshError; retain the previous successful snapshot.
      });
    });
  }

  #requestRefresh(reason: string): Promise<AccountProviderConfigSnapshot> {
    // A running refresh started before this request and may have read settings/account identity that a later caller write changed
    // (for example, Provisioning writes Setting before replacing credentials). Reusing that refresh could return its stale failure as this request's result.
    // The refresh contract is to return a run that covers the state after this request.
    const generation = this.#requestedGeneration + 1;
    this.#requestedGeneration = generation;
    this.#pendingReasons.add(reason);
    const result = new Promise<AccountProviderConfigSnapshot>((resolve, reject) => {
      this.#refreshWaiters.push({ generation, resolve, reject });
    });
    if (!this.#refreshInFlight) this.#startRefresh();
    return result;
  }

  #startRefresh(): Promise<AccountProviderConfigSnapshot> {
    const refresh = this.#runRefreshLoop();
    this.#refreshInFlight = refresh;
    void refresh.then(
      () => this.#finishRefresh(refresh),
      () => this.#finishRefresh(refresh),
    );
    return refresh;
  }

  #finishRefresh(refresh: Promise<AccountProviderConfigSnapshot>): void {
    if (this.#refreshInFlight !== refresh) return;
    this.#refreshInFlight = null;
    if (this.#disposed || this.#pendingReasons.size === 0) return;

    // The current run exits the refresh loop early on failure; events added during the failure remain pending.
    // Start another run after releasing in-flight, or account state stays on the old snapshot until another external event arrives.
    void this.#startRefresh().catch(() => {
      // No caller awaits subsequent runs; errors have already been published through onDidRefreshError and the last-known-good snapshot is retained.
    });
  }

  async #runRefreshLoop(): Promise<AccountProviderConfigSnapshot> {
    let latest = this.#snapshot;
    while (this.#pendingReasons.size > 0) {
      // Respond to all requests submitted before this run began with its result; requests arriving after it started are handled by the next run.
      const generation = this.#requestedGeneration;
      const reasons = [...this.#pendingReasons];
      this.#pendingReasons.clear();
      let config: ProviderConfigSnapshot | undefined;
      try {
        config = await this.#configSource.read();
        const configuredProviders = config.zcodeBuiltinProviders;
        const { providers, states } = await this.#resolve({
          configRevision: config.zcodeBuiltinRevision,
          configuredProviders,
          previousProviders: latest?.providers ?? ProviderConfigMap.empty(),
          previousStates: latest?.states,
          reasons: Object.freeze(reasons),
        });
        // Account Snapshot already expresses the Overlay source; the injected Resolver and Account Schema own its target and field boundaries.
        // Gating again by Built-in access.type would incorrectly reject entitled-only overlays published for off-peak Providers at the account layer,
        // preventing the entire Registry from starting.
        this.#assertNotDisposed();
        // Queries may overlap Built-in/credential updates; discard stale runs instead of publishing them temporarily and correcting later.
        const currentConfig = await this.#configSource.read();
        this.#assertNotDisposed();
        if (
          this.#pendingReasons.size > 0 ||
          currentConfig.zcodeBuiltinRevision !== config.zcodeBuiltinRevision
        ) {
          this.#pendingReasons.add("superseded-resolution");
          continue;
        }
        const basedOnZCodeBuiltinRevision = config.zcodeBuiltinRevision;
        const next = createAccountProviderConfigSnapshot(
          basedOnZCodeBuiltinRevision,
          providers,
          states,
        );
        const revision = next.revision;
        if (latest?.revision === revision) {
          this.#resolveRefreshWaiters(generation, latest);
          continue;
        }
        const hadSnapshot = latest !== null;
        latest = next;
        this.#snapshot = latest;
        this.#resolveRefreshWaiters(generation, latest);
        if (hadSnapshot) {
          const changeReason = reasons.join(",");
          for (const listener of this.#changeListeners) listener(changeReason);
        }
      } catch (error) {
        const event = Object.freeze({ error, reasons: Object.freeze(reasons) });
        for (const listener of this.#errorListeners) listener(event);
        if (!latest && config) {
          // Treating an initial account network/credential resolution failure as a ready barrier for the entire Registry
          // also prevented API/Personal Providers that do not depend on accounts from starting. Unknown account state should only fail closed explicitly.
          latest = createFailClosedAccountProviderConfigSnapshot(config);
          this.#snapshot = latest;
          this.#resolveRefreshWaiters(generation, latest);
          continue;
        }
        // Reject only requests submitted before this run started; later requests remain pending and #finishRefresh starts the next run to answer them.
        this.#rejectRefreshWaiters(generation, error);
        throw error;
      }
    }
    if (!latest) throw new Error("Account Provider Service 尚未产生快照");
    return latest;
  }

  #resolveRefreshWaiters(generation: number, snapshot: AccountProviderConfigSnapshot): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.resolve(snapshot);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #rejectRefreshWaiters(generation: number, error: unknown): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("AccountProviderService 已 dispose");
  }
}
