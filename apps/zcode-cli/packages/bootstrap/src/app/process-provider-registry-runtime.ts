import {
  AccountProviderService,
  MutableAccountProviderConfigSource,
  createDerivedAcpAgentConfigSource,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
} from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZCodeRuntimeEnv,
  ZCODE_VERSION,
} from "@zcode/shared";
import { dirname, join } from "node:path";
import {
  NodeForkAcpAgentStore,
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveForkAcpAgentsFilePath,
  resolveNodeProviderRuntimePaths,
  downloadZCodeBuiltinRelease,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import {
  createSharedZCodeCredentialStore,
  migrateLegacySiwcCredentials,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";
import {
  createStandaloneChatGptPlanConfigSourceWrapper,
  createStandaloneProviderRuntimeHeadersPort,
  readStandaloneAccountProviderConfigSnapshot,
} from "./standalone-account-provider-runtime.js";

export interface ProcessProviderRegistryRuntimeOptions {
/** Standalone Prompt CLI / TUI owns its account credentials and one-time import of legacy config. */
  readonly standalone?: {
    readonly credentialStore?: SharedZCodeCredentialStore;
    readonly legacyCliUserConfigFilePath?: string;
    readonly onAccountInitializationError?: (error: unknown) => void;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  }

  const accountSource = new MutableAccountProviderConfigSource();
  const credentialStore = options.standalone
    ? (options.standalone.credentialStore ?? createSharedZCodeCredentialStore({ env: { ...env } }))
    : undefined;
  // The derived per-account ChatGPT plan entries must exist in EVERY process registry: a
  // Desktop Worker resolves model executions against its own registry, and the host delivers
  // account snapshots whose basedOnZCodeBuiltinRevision must match this config source. Workers
  // enumerate the shared credential file read-only through the same wrapper (the local agent
  // runs on the same machine and user as the host that owns the SIWC credentials).
  const chatGptPlanConfigStore =
    credentialStore ?? createSharedZCodeCredentialStore({ env: { ...env } });
  // Migrate legacy flat SIWC credentials BEFORE the registry starts and before the credential
  // change subscription below is installed: the derived reads stay write-free afterwards, so
  // a listener-triggered account refresh can never wait on a migration write that is itself
  // waiting for that listener (the credential store awaits its listeners on save). A failing
  // migration must not block startup: the derived source degrades to no chatgpt entries and
  // the fail-closed account overlay keeps the registry bootable.
  await migrateLegacySiwcCredentials(chatGptPlanConfigStore).catch(() => undefined);
  let standaloneAccount: AccountProviderService | undefined;
  const bundledFile = options.standalone
    ? env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim()
    : undefined;
  // ACP agent records (fork sidecar) are derived into this worker's Registry in the same order as
  // the host: the ChatGPT plan wrapper is inner, the ACP derivation outer. The worker only reads the
  // sidecar; the host owns the one-shot inline migration and every write.
  const chatGptPlanConfigWrapper = createStandaloneChatGptPlanConfigSourceWrapper(chatGptPlanConfigStore);
  const acpAgentStore = new NodeForkAcpAgentStore({
    filePath: resolveForkAcpAgentsFilePath(paths.personalFilePath),
  });
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    wrapConfigSource: (source) =>
      createDerivedAcpAgentConfigSource(chatGptPlanConfigWrapper(source), acpAgentStore),
    // Same development-runtime signal as the host ACP gate (specs/acp-agent-runtime.md).
    acpExecutable: resolveZCodeRuntimeEnv(env) === "development",
    ...(bundledFile
      ? {
          zcodeBuiltinFilePath: bundledFile,
          zcodeBuiltinActiveFilePath: paths.zcodeBuiltinFilePath,
          zcodeBuiltinRemote: {
            controlFilePath: join(
              dirname(paths.zcodeBuiltinFilePath),
              "zcode-builtin-refresh.json",
            ),
            resolveEndpointKey: () => resolveRuntimeZCodeEndpointOrigin(env),
            fetchRelease: (endpointOrigin, signal) =>
              downloadZCodeBuiltinRelease({
                endpointOrigin,
                signal,
                appVersion: ZCODE_VERSION,
                platform: resolveZCodeBuiltinClientPlatform(),
                request: options.standalone?.request ?? globalThis.fetch,
              }),
            onRefreshResult: options.standalone?.onBuiltinRefreshResult,
          },
        }
      : {}),
    onZCodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    accountSource,
    ...(credentialStore
      ? {
          createAccountSource(configService) {
            standaloneAccount = new AccountProviderService({
              configSource: configService,
              async resolve({ configRevision, configuredProviders }) {
                // Use the Built-in value captured for this update rather than asynchronously reading another file and only attaching a new revision.
                const snapshot = await readStandaloneAccountProviderConfigSnapshot(
                  credentialStore,
                  env,
                  {
                    revision: configRevision,
                    providers: configuredProviders,
                  },
                );
                return {
                  providers: snapshot.providers,
                  states: snapshot.states ?? {},
                };
              },
            });
            standaloneAccount.onDidRefreshError(({ error }) => {
              try {
                options.standalone?.onAccountInitializationError?.(error);
              } catch {
                /* Observation callbacks must not change account facts. */
              }
            });
            return standaloneAccount;
          },
        }
      : {}),
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  const disposeRecovery = standaloneAccount
    ? runtime.onDidCheckZCodeBuiltin(async () => {
        // Read through the derived source: the account snapshot is based on the derived
        // builtin revision, so comparing against the raw revision would loop forever.
        const [config, account] = await Promise.all([
          runtime.registryConfigSource.read(),
          standaloneAccount!.read(),
        ]);
        if (config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision)
          await standaloneAccount!.refresh("builtin-account-recovery");
      })
    : undefined;
  // Reuse AccountService's serialization and stale-result discard behavior; credential changes and Built-in changes must not publish independently.
  const standaloneHeaders = credentialStore
    ? createStandaloneProviderRuntimeHeadersPort(credentialStore, env)
    : undefined;
  const disposeCredentialSubscription = credentialStore?.onDidChange?.(async () => {
    await standaloneHeaders?.invalidateChangedCredentials();
    await standaloneAccount!.refresh("standalone-credentials-changed");
    await runtime.registryService.refresh("standalone-credentials-barrier");
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      return Object.freeze({
        accountSource: standaloneAccount ?? accountSource,
        async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
          if (standaloneAccount)
            throw new Error("Standalone Account 由本进程管理，不接收 Host 覆盖");
          const changed = accountSource.replace(next, "host-account-config");
          // Source deduplication proves only that the update was received, not that the last refresh
          // succeeded. Refresh again on redelivery. If companion config has not arrived, the Registry keeps
          // the full old snapshot; do not present receipt as application confirmation.
          await runtime.registryService.refresh("host-account-config");
          return changed;
        },
        dispose() {
          disposeCredentialSubscription?.();
          standaloneHeaders?.clearProjectTokens();
          disposeRecovery?.();
          standaloneAccount?.dispose();
          modelSelectionConfigRepository.dispose();
          acpAgentStore.dispose();
          runtime.dispose();
        },
        ...(credentialStore
          ? {
              providerRuntimeHeadersPort: standaloneHeaders!,
            }
          : {}),
        runtime,
        /** Read-only view of the ACP sidecar for turn-time launch config (no migration here). */
        acpAgentStore,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      disposeCredentialSubscription?.();
      modelSelectionConfigRepository.dispose();
      acpAgentStore.dispose();
      throw error;
    }
  } catch (error) {
    disposeCredentialSubscription?.();
    disposeRecovery?.();
    standaloneAccount?.dispose();
    acpAgentStore.dispose();
    runtime.dispose();
    throw error;
  }
}

/** Parse the protocol envelope into the third-layer Account Config Overlay used by the process Registry. */
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision 不能为空");
  const basedOnZCodeBuiltinRevision = input.basedOnZCodeBuiltinRevision.trim();
  if (!basedOnZCodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision 不能为空");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // Applies only to regular account envelopes for managed Workers; standalone CLI, API, and off-peak paths do not need current.
    if (
      isBuiltinModelProviderId(providerId) &&
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State 缺少 current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnZCodeBuiltinRevision,
    providers,
    // This belongs to the same snapshot as the Overlay; do not update only the revision and lose the current connection state.
    ...(input.states ? { states: input.states } : {}),
  });
}
