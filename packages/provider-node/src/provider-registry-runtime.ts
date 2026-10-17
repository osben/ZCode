import {
  ProviderRegistryService,
  MutableAccountProviderConfigSource,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  NodeProviderConfigRuntime,
  type NodeProviderConfigRuntimeOptions,
} from "./provider-config-runtime.js";

export interface NodeProviderRegistryRuntimeOptions extends NodeProviderConfigRuntimeOptions {
  readonly accountSource?: ProviderSource<AccountProviderConfigSnapshot>;
  readonly createAccountSource?: (
    configSource: ProviderSource<ProviderConfigSnapshot>,
  ) => ProviderSource<AccountProviderConfigSnapshot>;
  /**
   * Decorate the config source the Registry and Account layer observe (e.g. derived
   * per-account ChatGPT plan providers). Mutations still go to the raw config service,
   * which stays exposed as `configService`.
   */
  readonly wrapConfigSource?: (
    source: ProviderSource<ProviderConfigSnapshot>,
  ) => ProviderSource<ProviderConfigSnapshot>;
}

/** Shared Config + Registry lifecycle within one Node.js process. */
export class NodeProviderRegistryRuntime {
  readonly configService: NodeProviderConfigRuntime["configService"];
  /** Config source the Registry and Account layer read (possibly derived); mutations use `configService`. */
  readonly registryConfigSource: ProviderSource<ProviderConfigSnapshot>;
  readonly registryService: ProviderRegistryService;
  readonly #configRuntime: NodeProviderConfigRuntime;
  readonly #accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  #disposed = false;

  constructor(options: NodeProviderRegistryRuntimeOptions) {
    this.#configRuntime = new NodeProviderConfigRuntime(options);
    this.configService = this.#configRuntime.configService;
    this.registryConfigSource = options.wrapConfigSource
      ? options.wrapConfigSource(this.configService)
      : this.configService;
    this.#accountSource =
      options.createAccountSource?.(this.registryConfigSource) ??
      options.accountSource ??
      new MutableAccountProviderConfigSource();
    this.registryService = new ProviderRegistryService({
      configSource: this.registryConfigSource,
      accountSource: this.#accountSource,
    });
  }

  async start(): Promise<void> {
    this.#assertNotDisposed();
    await this.#configRuntime.start();
    if (this.#accountSource instanceof MutableAccountProviderConfigSource) {
      const account = await this.#accountSource.read();
      if (account.basedOnZCodeBuiltinRevision === "uninitialized") {
        this.#accountSource.replace(
          createFailClosedAccountProviderConfigSnapshot(await this.registryConfigSource.read()),
          "initial-fail-closed",
        );
      }
    }
    return this.registryService.start();
  }

  get personalRepository(): NodeProviderConfigRuntime["personalRepository"] {
    return this.#configRuntime.personalRepository;
  }

  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    return this.#configRuntime.onDidCheckZCodeBuiltin(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.registryService.dispose();
    this.#configRuntime.dispose();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeProviderRegistryRuntime 已 dispose");
  }
}

export function createNodeProviderRegistryRuntime(
  options: NodeProviderRegistryRuntimeOptions,
): NodeProviderRegistryRuntime {
  return new NodeProviderRegistryRuntime(options);
}
