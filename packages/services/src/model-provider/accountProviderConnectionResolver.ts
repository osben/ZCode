import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountProviderUnavailableReason,
  AccountProviderConnectionResolver,
  AccountProviderConnectionResult,
  ProviderConfigSnapshot,
  ProviderSource,
} from "@zcode/provider";
import { AccountProviderService, createAccountProviderConfigResolver } from "@zcode/provider";
import {
  type ApiClient,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type {
  CodingPlanAvailabilityProvider,
  CodingPlanAvailabilityResult,
  CodingPlanUnavailableReason,
} from "#src/model-provider/codingPlanProviderAvailability.js";
import {
  validateBigModelAccountProviderAvailability,
  validateZaiAccountProviderAvailability,
} from "#src/model-provider/codingPlanProviderAvailability.js";

export interface AccountProviderConnectionSettings {
  readonly providerFamilyDomain: ProviderFamilyDomain | null;
  readonly selections: ProviderFamilyConnectionSelectionSettings;
  /** The Host cannot yet determine identity while importing a legacy connection; runtime fact only, not written to config or protocol. */
  readonly unresolvedFamilies?: readonly ProviderFamilyDomain[];
}

export interface AccountProviderFamilyAvailabilityInput {
  readonly family: ProviderFamilyDomain;
  readonly providers: readonly CodingPlanAvailabilityProvider[];
  readonly selections: ProviderFamilyConnectionSelectionSettings;
}

export type AccountProviderFamilyAvailabilityResolver = (
  input: AccountProviderFamilyAvailabilityInput,
) => Promise<Partial<Record<string, CodingPlanAvailabilityResult>>>;

export interface AccountProviderConnectionResolverOptions {
  /** ChatGPT plan (SIWC) entitlement source; absent disables the chatgpt overlay. */
  loadChatGptPlanEntitlement?: () => Promise<"entitled" | "identity-only" | "signed-out">;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadCodingPlanApiKey: (
    providerId: string,
    family: ProviderFamilyDomain,
    accountIdentity: string,
    forceRefresh: boolean,
  ) => Promise<string | null>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveFamilyAvailability: AccountProviderFamilyAvailabilityResolver;
}

export interface CodingPlanFamilyAvailabilityResolverOptions {
  readonly apiClient: ApiClient;
  readonly credentialService?: {
    load(key: string): Promise<string | null>;
  };
}

export interface AccountProviderConfigSourceOptions extends AccountProviderConnectionResolverOptions {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
}

/**
 * off-peak and highspeed are not standalone plans; they are execution entry points derived
 * from a connected personal/team Coding Plan: per-request auth comes from a ticket and the
 * highspeed-card JWT respectively, with no plan key of their own to validate. They therefore
 * neither enter Coding Plan availability checks nor compare modes directly by selection.kind.
 */
function isCodingPlanDerivedMode(mode: string | undefined): mode is "off-peak" | "highspeed" {
  return mode === "off-peak" || mode === "highspeed";
}

/**
 * Project the existing account domain, connection mode, and plan entitlements into a domain-level Connection Result.
 *
 * This adapter does not store credentials. The injected dependency determines the physical source for Personal Coding Plan keys;
 * dynamic Start/Team credentials continue to be read per request by the existing availability dependency.
 */
export function createAccountProviderConnectionResolver(
  options: AccountProviderConnectionResolverOptions,
): AccountProviderConnectionResolver {
  let previousScopes = new Map<string, string>();
  return async ({ configuredProviders, reasons = [] }) => {
    const settings = structuredClone(await options.readSettings());
    const forceCredentialRefresh = reasons.some(isCredentialRefreshReason);
    const accountIdentityByFamily = new Map<ProviderFamilyDomain, Promise<string | null>>();
    const loadAccountIdentity = (family: ProviderFamilyDomain) => {
      const existing = accountIdentityByFamily.get(family);
      if (existing) return existing;
      const pending = options.loadAccountIdentity(family).then((identity) => {
        const normalized = identity?.trim() ?? "";
        return normalized || null;
      });
      accountIdentityByFamily.set(family, pending);
      return pending;
    };
    const availabilityByProviderId = new Map<string, CodingPlanAvailabilityResult>();

    for (const family of ["zai", "bigmodel"] as const) {
      const configured = configuredProviders
        .entries()
        .flatMap(([providerId, config]) =>
          config.access?.type === "zhipu-account" &&
          config.access.accountType === family &&
          config.access.mode &&
          !isCodingPlanDerivedMode(config.access.mode)
            ? [{ providerId, config, planKind: config.access.mode }]
            : [],
        );
      if (configured.length === 0) continue;

      // Legacy team identity completion restricts only paid access; Start depends only on the currently signed-in account.
      const queryable = configured.filter(({ providerId, planKind }) => {
        if (settings.unresolvedFamilies?.includes(family) && planKind !== "start-plan") {
          availabilityByProviderId.set(providerId, { kind: "unknown" });
          return false;
        }
        return true;
      });
      if (queryable.length === 0) continue;

      const accountIdentity = await loadAccountIdentity(family);
      if (!accountIdentity) {
        for (const { providerId } of queryable) {
          availabilityByProviderId.set(providerId, {
            kind: "unavailable",
            reason: "coding_plan_not_connected",
          });
        }
        continue;
      }

      const availabilityProviders = await Promise.all(
        queryable.map(async ({ providerId, planKind }) => ({
          providerId,
          family,
          planKind,
          apiKey:
            planKind !== "team-coding-plan"
              ? await options
                  .loadCodingPlanApiKey(providerId, family, accountIdentity, forceCredentialRefresh)
                  .catch(() => null)
              : null,
        })),
      );
      const resolved = await options.resolveFamilyAvailability({
        family,
        providers: availabilityProviders,
        selections: settings.selections,
      });
      for (const { providerId } of queryable) {
        availabilityByProviderId.set(providerId, resolved[providerId] ?? { kind: "unknown" });
      }
    }

    const connections: AccountProviderConnectionResult[] = [];
    if (options.loadChatGptPlanEntitlement) {
      const chatgptStatus = await options.loadChatGptPlanEntitlement().catch(() => "signed-out");
      for (const [providerId, config] of configuredProviders.entries()) {
        if (config.access?.type !== "chatgpt-account") continue;
        connections.push(
          chatgptStatus === "entitled"
            ? { providerId, status: "available", current: true }
            : {
                providerId,
                status: "unavailable",
                // Protocol enum values: consent lacked the plan scope vs not signed in.
                unavailableReason:
                  chatgptStatus === "identity-only" ? "not-entitled" : "not-authenticated",
              },
        );
      }
    }
    const scopes = new Map<string, string>();
    for (const [providerId, config] of configuredProviders.entries()) {
      const access = config.access;
      if (access?.type !== "zhipu-account") continue;
      if (!access.accountType || !access.mode) {
        connections.push({ providerId, status: "unavailable" });
        continue;
      }
      const selection = settings.selections[access.accountType];
      // last-known-good is valid only for the same account and Team identity. A network failure after switching accounts must not revive old entitlements.
      const scope = JSON.stringify([
        await loadAccountIdentity(access.accountType),
        access.mode === "team-coding-plan" && selection?.kind === "team-coding-plan"
          ? [selection.organizationId, selection.projectId, selection.productId]
          : null,
      ]);
      scopes.set(providerId, scope);
      const resetPrevious =
        previousScopes.has(providerId) && previousScopes.get(providerId) !== scope;
      if (isCodingPlanDerivedMode(access.mode)) {
        const selectedPlanKind = selection?.kind;
        const matchingPlanAvailable =
          settings.providerFamilyDomain === access.accountType &&
          (selectedPlanKind === "individual-coding-plan" ||
            selectedPlanKind === "team-coding-plan") &&
          configuredProviders
            .entries()
            .some(
              ([candidateId, candidate]) =>
                candidate.access?.type === "zhipu-account" &&
                candidate.access.accountType === access.accountType &&
                candidate.access.mode === selectedPlanKind &&
                availabilityByProviderId.get(candidateId)?.kind === "available",
            );
        connections.push({
          providerId,
          status: matchingPlanAvailable ? "available" : "unavailable",
        });
        continue;
      }
      const availability = availabilityByProviderId.get(providerId) ?? {
        kind: "unknown" as const,
      };
      connections.push({
        providerId,
        status: availability.kind,
        // Publish the reason together with the connection result. Without it, the UI can only display "signed in but no plan"
        // as "disconnected".
        ...(availability.kind === "unavailable"
          ? {
              unavailableReason: resolveAccountUnavailableReason(availability.reason),
            }
          : {}),
        // Start follows the signed-in identity, while paid plans follow the selected connection; both can be current simultaneously without rewriting entitlements or configuration.
        current:
          settings.providerFamilyDomain === access.accountType &&
          (access.mode === "start-plan"
            ? Boolean(await loadAccountIdentity(access.accountType))
            : selection?.kind === access.mode),
        // Two Teams share a Provider ID, so the observer must compare their complete identities from the same snapshot;
        // do not mistake manually switching plans/accounts for the original plan becoming invalid. This belongs only in Account State, not Config.
        connectionKey: createHash("sha256")
          .update(
            JSON.stringify([
              await loadAccountIdentity(access.accountType),
              access.accountType,
              access.mode === "start-plan" ? { kind: "start-plan" } : (selection ?? null),
            ]),
          )
          .digest("hex"),
        ...("models" in availability ? { models: availability.models } : {}),
        ...("effectiveAt" in availability ? { effectiveAt: availability.effectiveAt } : {}),
        ...(resetPrevious ? { resetPrevious: true } : {}),
      });
    }
    // An entitlement query may span an account/plan switch, combining old settings with a new identity into a result ready for publication.
    // Check this round's scope before publishing; on failure, do not advance previousScopes or the next round may treat
    // the unpublished account as last-known-good. Retries remain driven by existing refresh events.
    const identitiesUnchanged = await Promise.all(
      [...accountIdentityByFamily].map(
        async ([family, captured]) =>
          (await captured) === ((await options.loadAccountIdentity(family))?.trim() || null),
      ),
    );
    if (
      identitiesUnchanged.some((unchanged) => !unchanged) ||
      !isDeepStrictEqual(settings, await options.readSettings())
    ) {
      throw new Error("账号查询期间连接或身份发生变化，丢弃过期结果");
    }
    previousScopes = scopes;
    return Object.freeze(connections);
  };
}

function isCredentialRefreshReason(reason: string): boolean {
  // ProviderSettingsFacade adds a settings: prefix to login refresh reasons; missing this would keep reusing an invalid key
  // after signing in again to the same account. Match the final reason segment exactly; ordinary refreshes still reuse the cache.
  return (
    reason.includes("oauth-callback") || reason.split(":").at(-1) === "oauth-login-entitlement"
  );
}

/**
 * Project Coding Plan availability reasons into account-domain reasons.
 * Account State is a general fact across families and does not directly reuse internal Coding Plan enums;
 * the UI depends only on these stable semantics and does not know the plan-query implementation.
 */
function resolveAccountUnavailableReason(
  reason: CodingPlanUnavailableReason,
): AccountProviderUnavailableReason {
  switch (reason) {
    case "coding_plan_not_authenticated":
      return "not-authenticated";
    case "coding_plan_not_connected":
      return "not-connected";
    case "coding_plan_auth_failed":
      return "credential-failed";
    case "coding_plan_not_entitled":
      return "not-entitled";
  }
}

/** Assemble Config, account connection resolution, and the third-layer Account Provider Config Source. */
export function createAccountProviderConfigSource(
  options: AccountProviderConfigSourceOptions,
): AccountProviderService {
  return new AccountProviderService({
    configSource: options.configSource,
    resolve: createAccountProviderConfigResolver(createAccountProviderConnectionResolver(options)),
  });
}

/** Create the production Family Availability Port using the current stable Plan query implementation. */
export function createCodingPlanFamilyAvailabilityResolver(
  options: CodingPlanFamilyAvailabilityResolverOptions,
): AccountProviderFamilyAvailabilityResolver {
  return ({ family, providers, selections }) => {
    const context = {
      apiClient: options.apiClient,
      credentialService: options.credentialService,
      providerFamilyConnectionSelections: selections,
    };
    return family === "zai"
      ? validateZaiAccountProviderAvailability(providers, context)
      : validateBigModelAccountProviderAvailability(providers, context);
  };
}

/**
 * Project the Active Model's static Access constraints onto the current account connection.
 *
 * Team scope and account version must not be frozen in the Model; the old Model would become invalid after an account switch.
 * Reread the current selection on each request; return dynamic access facts only when family and mode are compatible.
 */
export async function resolveCurrentAccountAccess(input: {
  readonly access: ZCodeProviderAccountAccess;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}): Promise<ZCodeAccountAccess | null> {
  const settings = await input.readSettings();
  const { accountType, mode } = input.access;
  if (settings.providerFamilyDomain !== accountType) return null;
  if (mode === "start-plan") {
    if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
    return { type: "zhipu-account", family: accountType, planKind: "start-plan" };
  }
  const selection = settings.selections[accountType];
  if (!selection) return null;
  if (isCodingPlanDerivedMode(mode)) {
    if (selection.kind !== "individual-coding-plan" && selection.kind !== "team-coding-plan") {
      return null;
    }
  } else if (selection.kind !== mode) {
    return null;
  }
  if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
  if (selection.kind === "team-coding-plan") {
    return {
      type: "zhipu-account",
      family: accountType,
      planKind: selection.kind,
      productId: selection.productId,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
    };
  }
  return {
    type: "zhipu-account",
    family: accountType,
    planKind: selection.kind,
  };
}
