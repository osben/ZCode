import {
  NodeModelSelectionConfigRepository,
  createNodeModelSelectionFacade,
  migrateInlineAcpProviders,
} from "@zcode/provider-node";
import {
  ProviderRegistryService,
  ProviderSettingsFacade,
  createDerivedAcpAgentConfigSource,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ForkAcpAgentStore,
  type ProviderConfigSnapshot,
  type ProviderSettingsMutationTarget,
  type ProviderSource,
} from "@zcode/provider";
import {
  createProviderConfigRuntime,
  type ProviderConfigRuntime,
  type ProviderConfigRuntimeOptions,
} from "./providerConfigRuntime.js";
import {
  createModelSelectionService,
  createProviderSettingsService,
  type IModelSelectionService,
  type IProviderSettingsService,
  type ModelSelectionConfiguredDefaultSource,
  type ProviderSettingsConnectivityTester,
} from "./providerFacadeServices.js";
import type { ProviderSettingsAcpAgentsBridge } from "./acpAgentsContract.js";
import { createAcpAgentWriter } from "./acpAgentWriter.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("provider-runtime");

export interface ProviderRuntimeOptions extends ProviderConfigRuntimeOptions {
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly wrapConfigSource?: (
    source: ProviderSource<ProviderConfigSnapshot>,
  ) => ProviderSource<ProviderConfigSnapshot>;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly acpAgents?: ProviderSettingsAcpAgentsBridge;
  readonly acpAgentStore?: ProviderRuntimeDependencies["acpAgentStore"];
  readonly acpExecutable?: boolean;
}

export interface ProviderRuntimeDependencies {
  readonly configRuntime: ProviderConfigRuntime;
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  /**
   * Decorates the config source the Registry and Account layer observe (derived per-account
   * ChatGPT plan providers). Mutations still go to the raw config service.
   */
  readonly wrapConfigSource?: (
    source: ProviderSource<ProviderConfigSnapshot>,
  ) => ProviderSource<ProviderConfigSnapshot>;
  readonly disposeAccountSource?: () => void;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly acpAgents?: ProviderSettingsAcpAgentsBridge;
  /**
   * Fork-owned sidecar of ACP agent records. When present, its records are derived into the
   * registry config source as `acp:<agentId>` personal providers, legacy inline records are
   * migrated out of `provider_config.json` at start, and Settings can save agents.
   */
  readonly acpAgentStore?: ForkAcpAgentStore & { dispose?(): void };
  /** Development-only gate: ACP models are executable only when true (specs/acp-agent-runtime.md). */
  readonly acpExecutable?: boolean;
  readonly modelSelectionConfiguredDefaultSource?: ModelSelectionConfiguredDefaultSource;
  readonly disposeModelSelectionConfiguredDefaultSource?: () => void;
}

interface RefreshableProviderSource<TSnapshot> extends ProviderSource<TSnapshot> {
  refresh?(reason: string): Promise<TSnapshot>;
}

/**
 * Ordinary API Providers can run independently before account capabilities are assembled.
 * Account Providers fail closed explicitly through an access.entitled=false Overlay aligned with the current Built-in revision.
 */
export class EmptyAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly configSource: ProviderSource<ProviderConfigSnapshot>) {}

  async read(): Promise<AccountProviderConfigSnapshot> {
    return createFailClosedAccountProviderConfigSnapshot(await this.configSource.read());
  }

  onDidChange(): () => void {
    return () => {};
  }
}

/** Assemble a process-wide shared Provider Config, Registry, and Facade. */
export class ProviderRuntime {
  readonly configService: ProviderConfigRuntime["configService"];
  /** Config source the Registry and Account layer read (possibly derived); mutations use `configService`. */
  readonly registryConfigSource: ProviderSource<ProviderConfigSnapshot>;
  readonly registryService: ProviderRegistryService;
  readonly providerSettings: IProviderSettingsService;
  readonly modelSelection: IModelSelectionService;
  readonly #configRuntime: ProviderConfigRuntime;
  readonly #disposeAccountSource?: () => void;
  readonly #disposeBuiltinRecovery: () => void;
  readonly #modelSelectionRuntime: IModelSelectionService & { dispose(): void };
  readonly #disposeModelSelectionConfiguredDefaultSource?: () => void;
  readonly #acpAgentStore?: ForkAcpAgentStore & { dispose?(): void };
  /** The sidecar store, present only in development runtimes; the derivation, writer and migration use it. */
  readonly #gatedAcpAgentStore?: ForkAcpAgentStore;
  #startPromise: ReturnType<ProviderRegistryService["start"]> | null = null;
  #disposed = false;

  constructor(dependencies: ProviderRuntimeDependencies) {
    this.#configRuntime = dependencies.configRuntime;
    this.#disposeAccountSource = dependencies.disposeAccountSource;
    this.#disposeModelSelectionConfiguredDefaultSource =
      dependencies.disposeModelSelectionConfiguredDefaultSource;
    this.configService = this.#configRuntime.configService;
    this.#acpAgentStore = dependencies.acpAgentStore;
    // Dev-only stabilization gate (specs/acp-agent-runtime.md "Dev-only visibility"): the sidecar is
    // derived into providers and written to only when the host is a development runtime. A packaged
    // host keeps the sidecar file on disk untouched and reads no `acp:` provider from it.
    this.#gatedAcpAgentStore =
      dependencies.acpExecutable === true ? dependencies.acpAgentStore : undefined;
    const wrappedConfigSource = dependencies.wrapConfigSource
      ? dependencies.wrapConfigSource(this.configService)
      : this.configService;
    this.registryConfigSource = this.#gatedAcpAgentStore
      ? createDerivedAcpAgentConfigSource(wrappedConfigSource, this.#gatedAcpAgentStore)
      : wrappedConfigSource;
    const accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot> =
      dependencies.accountSource ?? new EmptyAccountProviderConfigSource(this.registryConfigSource);
    this.#disposeBuiltinRecovery = this.#configRuntime.onDidCheckZCodeBuiltin(async () => {
      const [config, account] = await Promise.all([
        this.registryConfigSource.read(),
        accountSource.read(),
      ]);
      if (!this.#disposed && config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision) {
        await accountSource.refresh?.("builtin-account-recovery");
      }
    });
    this.registryService = new ProviderRegistryService({
      configSource: this.registryConfigSource,
      accountSource,
      acpExecutable: dependencies.acpExecutable === true,
    });
    const mutations = createSettingsMutationTarget(
      this.#configRuntime,
      this.registryService,
      accountSource,
    );
    const ensureReady = () => this.start();
    const settingsFacade = new ProviderSettingsFacade(this.registryService, mutations);
    this.providerSettings = createProviderSettingsService(
      settingsFacade,
      ensureReady,
      dependencies.testConnectivity,
      dependencies.acpAgents,
      this.#gatedAcpAgentStore
        ? createAcpAgentWriter(this.#gatedAcpAgentStore, this.#configRuntime.personalRepository)
        : undefined,
    );
    this.#modelSelectionRuntime = createModelSelectionService(
      createNodeModelSelectionFacade(this.registryService),
      ensureReady,
      dependencies.modelSelectionConfiguredDefaultSource,
    );
    this.modelSelection = this.#modelSelectionRuntime;
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("ProviderRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.#configRuntime
      .start()
      .then(() => this.#migrateInlineAcpProviders())
      .then(() => this.registryService.start());
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  async #migrateInlineAcpProviders(): Promise<void> {
    if (!this.#gatedAcpAgentStore) return;
    try {
      const result = await migrateInlineAcpProviders(
        this.#configRuntime.personalRepository,
        this.#gatedAcpAgentStore,
      );
      if (result.stripped) {
        log.info(undefined, "moved inline ACP providers to the fork sidecar", {
          copied: result.copied.length,
        });
      }
      if (result.kept.length > 0) {
        // These rules still make provider_config.json unreadable for upstream builds.
        log.warn(undefined, "inline ACP providers left in provider_config.json", {
          count: result.kept.length,
        });
      }
      if (result.conflicts.length > 0) {
        // The sidecar record wins on read. The differing inline rule is kept, never stripped, and this
        // runs once per runtime (the migration starts once in `start`), so it is not repeated per turn.
        log.warn(undefined, "inline ACP provider differs from the sidecar record; kept inline", {
          count: result.conflicts.length,
        });
      }
    } catch (error) {
      // Migration is retried on the next start; it must never block the provider runtime.
      log.warn(undefined, "inline ACP provider migration failed", { error });
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#acpAgentStore?.dispose?.();
    this.#disposeBuiltinRecovery();
    this.#modelSelectionRuntime.dispose();
    this.registryService.dispose();
    this.#disposeAccountSource?.();
    this.#disposeModelSelectionConfiguredDefaultSource?.();
    this.#configRuntime.dispose();
  }
}

function createSettingsMutationTarget(
  configRuntime: ProviderConfigRuntime,
  registryService: ProviderRegistryService,
  accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot>,
): ProviderSettingsMutationTarget {
  const configService = configRuntime.configService;
  return {
    createPersonalProvider: (input) => configService.createPersonalProvider(input),
    savePersonalProviderOverlay: (providerId, config, membership, metadata) =>
      configService.savePersonalProviderOverlay(providerId, config, membership, metadata),
    deletePersonalProvider: (providerId) => configService.deletePersonalProvider(providerId),
    reorderPersonalProviders: (providerIds) => configService.reorderPersonalProviders(providerIds),
    reorderPersonalModels: (providerId, modelIds, membership) =>
      configService.reorderPersonalModels(providerId, modelIds, membership),
    // Manual four-parameter forwarding used to drop newly added configuration modes; bind the full signature directly so assembly does not truncate write intent.
    addPersonalModel: configService.addPersonalModel.bind(configService),
    renamePersonalModel: (providerId, currentModelId, nextModelId, membership) =>
      configService.renamePersonalModel(providerId, currentModelId, nextModelId, membership),
    deletePersonalModel: (providerId, modelId, membership) =>
      configService.deletePersonalModel(providerId, modelId, membership),
    setPersonalModelEnabled: (providerId, modelId, enabled, membership) =>
      configService.setPersonalModelEnabled(providerId, modelId, enabled, membership),
    savePersonalModelDraft: (
      providerId,
      originalModelId,
      nextModelId,
      config,
      expectedPersonalRevision,
      useRecommendedConfig,
      membership,
    ) =>
      configService.savePersonalModelDraft(
        providerId,
        originalModelId,
        nextModelId,
        config,
        expectedPersonalRevision,
        useRecommendedConfig,
        membership,
      ),
    refresh: (reason) => registryService.refresh(reason),
    refreshSources: async (reason) => {
      const [builtinResult, accountResult] = await Promise.allSettled([
        configRuntime.refreshZCodeBuiltin({ force: true }),
        accountSource.refresh?.(reason) ?? Promise.resolve(),
      ]);
      // A failed remote Builtin update does not make the local config unusable. Throwing here used to roll back
      // plan switches and hide real account failures, so only the remote update is downgraded; account errors still propagate.
      if (builtinResult.status === "rejected") {
        log.warn(undefined, "Builtin remote update failed; continuing with local config", {
          reason,
          error: builtinResult.reason,
        });
      }
      const snapshot = await registryService.refresh(reason);
      if (accountResult.status === "rejected") throw accountResult.reason;
      return snapshot;
    },
  };
}

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  const {
    accountSource,
    testConnectivity,
    wrapConfigSource,
    acpAgents,
    acpAgentStore,
    acpExecutable,
    ...configRuntimeOptions
  } = options;
  const configRuntime = createProviderConfigRuntime(configRuntimeOptions);
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: configRuntime.personalRepository,
  });
  return createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource,
    testConnectivity,
    ...(wrapConfigSource ? { wrapConfigSource } : {}),
    ...(acpAgents ? { acpAgents } : {}),
    ...(acpAgentStore ? { acpAgentStore } : {}),
    ...(acpExecutable === undefined ? {} : { acpExecutable }),
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
  });
}

export function createProviderRuntimeFromConfigRuntime(
  dependencies: ProviderRuntimeDependencies,
): ProviderRuntime {
  return new ProviderRuntime(dependencies);
}
