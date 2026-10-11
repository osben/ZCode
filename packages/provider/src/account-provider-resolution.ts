import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderId,
} from "./config/index.js";
import type {
  AccountProviderResolveInput,
  AccountProviderResolver,
} from "./account-provider-service.js";
import type {
  AccountProviderState,
  AccountProviderUnavailableReason,
} from "./account-provider-state.js";

export type AccountProviderConnectionResult = {
  /** Do not reuse an old snapshot after account/organization identity changes; used only for this resolution and not stored in config. */
  readonly resetPrevious?: boolean;
  readonly current?: boolean;
  readonly connectionKey?: string;
  readonly effectiveAt?: number;
} & (
  | {
      readonly providerId: ProviderId;
      readonly status: "available" | "pending";
      readonly models?: readonly ModelId[];
    }
  | {
      readonly providerId: ProviderId;
      readonly status: "unavailable" | "unknown";
      /** Present only when status === "unavailable"; unknown means the reason could not be determined for this run. */
      readonly unavailableReason?: AccountProviderUnavailableReason;
    }
);

export interface ResolveAccountProviderConfigsInput {
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly connections: readonly AccountProviderConnectionResult[];
}

export type AccountProviderConnectionResolver = (
  input: Omit<AccountProviderResolveInput, "previousProviders">,
) => Promise<readonly AccountProviderConnectionResult[]>;

export function createAccountProviderConfigResolver(
  resolveConnections: AccountProviderConnectionResolver,
): AccountProviderResolver {
  return async (input) => {
    const connections = await resolveConnections({
      configRevision: input.configRevision,
      configuredProviders: input.configuredProviders,
      reasons: input.reasons ?? [],
    });
    const providers = resolveAccountProviderConfigs({
      configuredProviders: input.configuredProviders,
      previousProviders: input.previousProviders,
      connections,
    });
    const states: Record<string, AccountProviderState> = {};
    for (const connection of connections) {
      const previous = connection.resetPrevious
        ? undefined
        : input.previousStates?.[connection.providerId];
      const access = providers.get(connection.providerId)?.access;
      // unknown retains only the previous display fact; current always comes from this run's selection and cannot revive an old connection.
      // The reason field follows the same rule as availability: unknown reuses the previous run to avoid a network hiccup downgrading
      // "explicitly no entitlement" to an unknown reason.
      const unavailableReason =
        connection.status === "unknown" && previous
          ? previous.unavailableReason
          : connection.status === "unavailable"
            ? connection.unavailableReason
            : undefined;
      states[connection.providerId] = Object.freeze({
        ...(connection.status === "unknown" ? previous : {}),
        availability:
          connection.status === "unknown" && previous ? previous.availability : connection.status,
        entitled: access?.type === "zhipu-account" && access.entitled === true,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        ...(connection.current === undefined ? {} : { current: connection.current }),
        connectionKey: connection.connectionKey,
        ...(connection.effectiveAt === undefined ? {} : { effectiveAt: connection.effectiveAt }),
      });
    }
    return Object.freeze({ providers, states: Object.freeze(states) });
  };
}

/** Convert account connection results into the third-layer Account Provider Config used by Registry. */
export function resolveAccountProviderConfigs(
  input: ResolveAccountProviderConfigsInput,
): ProviderConfigMap {
  const connectionByProviderId = indexConnections(input.configuredProviders, input.connections);
  const resolved: Array<readonly [ProviderId, ProviderConfig]> = [];
  for (const [providerId, configured] of input.configuredProviders.entries()) {
    const access = configured.access;
    if (access?.type !== "zhipu-account") continue;
    const connection = connectionByProviderId.get(providerId) ?? {
      providerId,
      status: "unknown" as const,
    };

    if (connection.status === "available" || connection.status === "pending") {
      if (access.mode === "start-plan") {
        const models = normalizeModelIds(connection.models);
        resolved.push([
          providerId,
          new ProviderConfig({
            // An explicitly empty model list is authoritative for this run; do not retain an outdated allowlist.
            access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
            builtinModelIds: models,
          }),
        ]);
        continue;
      }
      resolved.push([
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
        }),
      ]);
      continue;
    }

    if (connection.status === "unavailable") {
      resolved.push([providerId, createEntitlementOverlay(false)]);
      continue;
    }

    const previous = connection.resetPrevious ? undefined : input.previousProviders.get(providerId);
    if (previous) {
      resolved.push([providerId, previous]);
    } else {
      resolved.push([providerId, createEntitlementOverlay(false)]);
    }
  }

  return new ProviderConfigMap(resolved);
}

function createEntitlementOverlay(entitled: boolean): ProviderConfig {
  return new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled }) });
}

function indexConnections(
  configuredProviders: ProviderConfigMap,
  connections: readonly AccountProviderConnectionResult[],
): ReadonlyMap<ProviderId, AccountProviderConnectionResult> {
  const result = new Map<ProviderId, AccountProviderConnectionResult>();
  for (const connection of connections) {
    if (result.has(connection.providerId)) {
      throw new Error(`重复 Account Provider 连接结果: ${connection.providerId}`);
    }
    const configured = configuredProviders.get(connection.providerId);
    if (!configured) {
      throw new Error(`Account 连接指向未配置 Provider: ${connection.providerId}`);
    }
    if (!isAccountConstrainedProvider(configured)) {
      throw new Error(`Account 连接指向非 Account Provider: ${connection.providerId}`);
    }
    result.set(connection.providerId, connection);
  }
  return result;
}

function isAccountConstrainedProvider(config: ProviderConfig): boolean {
  return config.access?.type === "zhipu-account";
}

function normalizeModelIds(values: readonly ModelId[] | null | undefined): readonly ModelId[] {
  const result: ModelId[] = [];
  for (const value of values ?? []) {
    const modelId = value.trim();
    if (!modelId) continue;
    result.push(modelId);
  }
  return Object.freeze(result);
}
