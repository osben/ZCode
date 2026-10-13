/*
 * Credential resolution and identity-header construction for ZCode's official Server MCP.
 *
 * This file is **logically equivalent but fully independent** from Off-Peak's offPeakRuntimeModel.ts:
 * it does not reuse its functions or change its behavior. The two flows are expected to evolve independently in plan requirements,
 * Team support, and credential channels, so a shared helper would make a change to either side require evaluating both.
 *
 * Three intentional differences from Off-Peak:
 *   1. Explicitly emit Bigmodel-Target-Type (there is currently no producer for it on the Off-Peak side).
 *   2. No mock credential branch (official MCP has no mock gateway; tests replace the source through dependency injection).
 *   3. Failure reasons use official_* categories rather than Off-Peak reason strings.
 *
 * Credential channel: Coding Plan credentials use `X-Bigmodel-Authorization` + the MaaS login JWT;
 * do not send `X-Coding-Plan-Api-Key`. The server marks the API key channel as “legacy clients only,” and sending both headers
 * is harmful: the JWT may pass quota lookup, but API-key ownership validation still runs, and one expired key can make the whole
 * request fail with 403. Off-Peak still uses the API key channel, another reason for the independence described above.
 */
import {
  OFFICIAL_MCP_AUTH_HEADER_NAMES,
  getModelProviderFamilySpec,
  zcodeProviderAccountAccessSchema,
  type OfficialMcpAuthFailureReason,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("official-mcp");

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_OAUTH_PROVIDER_KEY = "oauth:active_provider";

/**
 * Credential key for the MaaS login JWT (`oauth:<provider>:access_token`; see oauth/repo/oauthCredentialRepo.ts).
 *
 * Select the exact provider family and **never fall back across families**: using a ZAI business JWT for BigModel
 * Coding Plan creates a request that is guaranteed to fail, with a misleading “no plan” reason.
 * This logic is equivalent to but independent from the reset channel in bigmodelUsageQuotaProvider (see the file header).
 */
function maasJwtCredentialKey(providerFamily: "zai" | "bigmodel"): string {
  return `oauth:${getModelProviderFamilySpec(providerFamily).oauthProviderId}:access_token`;
}

/**
 * Compute the JWT's remaining lifetime (seconds) for logging only. **Does not participate in control flow**; returns undefined if parsing fails.
 *
 * Rationale: MaaS JWTs have no refresh flow. After expiration, the server returns an upstream 401 from queryCodingPlan,
 * but the client shows a message such as “Coding Plan required,” which does not match the cause. This value makes a
 * “mysterious 403” easy to recognize as “the token expired long ago.” Log only the number, never the token itself.
 */
function readJwtExpiresInSeconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded: unknown = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const exp = (decoded as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    return Math.round(exp - Date.now() / 1000);
  } catch {
    return undefined;
  }
}

/** Lifetime bucket size (seconds) for credential-resolution info logs; do not repeat entries within a bucket (see createCredentialResolvedLogKey). */
const CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS = 3600;

/**
 * Deduplication key for successful credential-resolution logs (exported only for unit tests; no other consumers).
 *
 * Production logs retain the JWT lifetime bucket to help distinguish expired credentials from an unavailable plan; never log raw credentials.
 * The resolver only coalesces in-flight requests and has no time-based cache, so deduplicate by hour to avoid an info log for every
 * MCP call. Log again when the credential crosses a bucket, becomes expired, or the plan type changes.
 */
export function createCredentialResolvedLogKey(input: {
  providerFamily: "zai" | "bigmodel";
  planTargetType: string | null;
  maasJwtExpiresInSeconds: number | undefined;
}): string {
  const expires = input.maasJwtExpiresInSeconds;
  const expiryBucket =
    expires === undefined
      ? "unparsable"
      : expires <= 0
        ? "expired"
        : `t${Math.floor(expires / CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS)}`;
  return `${input.providerFamily}|${input.planTargetType ?? "none"}|${expiryBucket}`;
}

let lastCredentialResolvedLogKey: string | undefined;

export interface OfficialMcpCredentialResolverDeps {
  accountRequestAuthService: {
    resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  };
  credentialService: { load(key: string): Promise<string | null | undefined> };
  modelSelectionService: {
    getView(): Promise<ModelSelectionView>;
  };
}

export type OfficialMcpPlanScope =
  | { targetType: "PERSONAL" }
  | { targetType: "TEAM"; organizationId: string; projectId: string };

export type OfficialMcpWireScope = OfficialMcpPlanScope | null;

/** Credential snapshot after successful resolution. Exists only in host/service process memory and may cross RPC only after redaction. */
export interface OfficialMcpCredentialSnapshot {
  jwt: string;
  /**
   * Raw MaaS login JWT (`oauth:<family>:access_token`, **without the Bearer prefix**).
   * buildOfficialMcpAuthHeaders adds the prefix, matching the existing reset/usage channel convention.
   */
  codingPlanAuthorization?: string;
  providerFamily: "zai" | "bigmodel";
  /** Product/quota ownership for the currently selected connection; null when a malformed legacy Team key cannot be assigned precisely. */
  planScope: OfficialMcpPlanScope | null;
  /** Scope of identity headers sent to Server MCP; null for ZAI Team, as on the Off-Peak path. */
  wireScope: OfficialMcpWireScope;
}

export type OfficialMcpCredentialOutcome =
  | { ok: true; snapshot: OfficialMcpCredentialSnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

type SelectedPlan = {
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  planScope: OfficialMcpPlanScope | null;
  wireScope: OfficialMcpWireScope;
};

type SelectedProvider = {
  providerId: string;
  access: ZCodeProviderAccountAccess;
};

function fail(reason: OfficialMcpAuthFailureReason): {
  ok: false;
  reason: OfficialMcpAuthFailureReason;
} {
  return { ok: false, reason };
}

/**
 * Determine the currently enabled Coding Plan Provider from the Registry; the account service then resolves the dynamic plan and Team scope.
 * Do not read or fabricate the current Team scope from static Provider Config.
 */
function resolveSelectedProvider(
  registry: ModelSelectionView,
): { ok: true; provider: SelectedProvider } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  const candidates = registry.providers.flatMap((provider) => {
    const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    return parsed.success &&
      (parsed.data.mode === "individual-coding-plan" || parsed.data.mode === "team-coding-plan")
      ? [{ providerId: provider.providerId, access: parsed.data }]
      : [];
  });
  if (candidates.length !== 1) {
    return fail("official_auth_plan_required");
  }
  return { ok: true, provider: candidates[0]! };
}

function resolveSelectedPlan(
  selectedProvider: SelectedProvider,
  access: ZCodeAccountAccess | null,
): { ok: true; plan: SelectedPlan } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  if (
    !access ||
    access.family !== selectedProvider.access.accountType ||
    (selectedProvider.access.mode === "team-coding-plan"
      ? access.planKind !== "team-coding-plan"
      : access.planKind !== "individual-coding-plan")
  ) {
    return fail("official_auth_plan_required");
  }
  const { providerId } = selectedProvider;
  const providerFamily = access.family;
  if (access.planKind === "team-coding-plan") {
    const teamScope: OfficialMcpPlanScope = {
      organizationId: access.organizationId,
      projectId: access.projectId,
      targetType: "TEAM",
    };
    return {
      ok: true,
      plan: {
        providerFamily,
        providerId,
        planScope: teamScope,
        wireScope: providerFamily === "bigmodel" ? teamScope : null,
      },
    };
  }
  return {
    ok: true,
    plan: {
      providerFamily,
      providerId,
      planScope: { targetType: "PERSONAL" },
      wireScope: { targetType: "PERSONAL" },
    },
  };
}

/** Non-secret selection fingerprint used to compare before/after resolution and prevent combining credentials from two selections in one request. */
function createSelectionFingerprint(registry: ModelSelectionView): string {
  return JSON.stringify({ revision: registry.revision, providers: registry.providers });
}

type OfficialMcpIdentitySnapshot = {
  activeProvider: "zai" | "bigmodel";
  jwt: string;
  registry: ModelSelectionView;
  selectionFingerprint: string;
};

async function readIdentitySnapshot(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<
  | { ok: true; snapshot: OfficialMcpIdentitySnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason }
> {
  const [registry, activeProviderValue, jwtValue] = await Promise.all([
    deps.modelSelectionService.getView(),
    deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY),
    deps.credentialService.load(ZCODE_JWT_TOKEN_KEY),
  ]);
  const activeProvider = activeProviderValue?.trim();
  const jwt = jwtValue?.trim() ?? "";
  if ((activeProvider !== "zai" && activeProvider !== "bigmodel") || !jwt) {
    return fail("official_auth_unavailable");
  }
  return {
    ok: true,
    snapshot: {
      activeProvider,
      jwt,
      registry,
      selectionFingerprint: createSelectionFingerprint(registry),
    },
  };
}

function isSameIdentitySnapshot(
  before: OfficialMcpIdentitySnapshot,
  after: OfficialMcpIdentitySnapshot,
): boolean {
  return (
    before.activeProvider === after.activeProvider &&
    before.jwt === after.jwt &&
    before.selectionFingerprint === after.selectionFingerprint
  );
}

function identityOnlyOutcome(identity: OfficialMcpIdentitySnapshot): OfficialMcpCredentialOutcome {
  log.debug(undefined, "official mcp identity-only credentials resolved", {
    providerFamily: identity.activeProvider,
    reason: "official_auth_plan_required",
  });
  return {
    ok: true,
    snapshot: {
      jwt: identity.jwt,
      planScope: null,
      providerFamily: identity.activeProvider,
      wireScope: null,
    },
  };
}

/**
 * Resolve official MCP credentials for the currently selected connection.
 *
 * Race protection: Registry, dynamic Account Access, active provider, zcode JWT, and MaaS JWT
 * may all change during resolution. Read each before and after and compare; if any differ, retry the entire operation.
 * Never combine credentials from two generations, whether “zcode JWT from ZAI and MaaS JWT from BigModel” (cross-family mixing)
 * or “old JWT + new JWT” (same-family token rotation). If two attempts remain unstable, return unavailable.
 */
export async function resolveOfficialMcpCredentials(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<OfficialMcpCredentialOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await readIdentitySnapshot(deps);
    if (!identity.ok) {
      if (attempt === 0) continue;
      return identity;
    }
    const selectedProvider = resolveSelectedProvider(identity.snapshot.registry);
    if (!selectedProvider.ok) {
      const latestIdentity = await readIdentitySnapshot(deps);
      if (
        !latestIdentity.ok ||
        !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot)
      ) {
        continue;
      }
      return identityOnlyOutcome(identity.snapshot);
    }
    const accountAccess = await deps.accountRequestAuthService.resolveAccessCurrent(
      selectedProvider.provider.access,
    );
    const selected = resolveSelectedPlan(selectedProvider.provider, accountAccess);
    if (!selected.ok) return selected;

    // The zcode JWT mirrors the global login identity; checking only selectedKey could combine a ZAI JWT with a BigModel key in one request.
    if (identity.snapshot.activeProvider !== selected.plan.providerFamily) {
      return fail("official_auth_unavailable");
    }

    const maasJwtKey = maasJwtCredentialKey(selected.plan.providerFamily);
    const codingPlanAuthorization = (await deps.credentialService.load(maasJwtKey))?.trim() ?? "";
    if (!codingPlanAuthorization) {
      // Classify as unavailable rather than plan_required: the login state is incomplete (sign in again),
      // not “no plan.” Both provider adapters require this token at sign-in, so the normal path does not hit this;
      // it mainly occurs with legacy login states from migration.
      log.warn(undefined, "official mcp maas jwt missing", {
        providerFamily: selected.plan.providerFamily,
        reason: "official_auth_unavailable",
      });
      return fail("official_auth_unavailable");
    }

    const [latestIdentity, latestMaasJwt] = await Promise.all([
      readIdentitySnapshot(deps),
      deps.credentialService.load(maasJwtKey),
    ]);
    const latestSelectedProvider = latestIdentity.ok
      ? resolveSelectedProvider(latestIdentity.snapshot.registry)
      : latestIdentity;
    const latestAccountAccess = latestSelectedProvider.ok
      ? await deps.accountRequestAuthService.resolveAccessCurrent(
          latestSelectedProvider.provider.access,
        )
      : null;
    if (
      !latestIdentity.ok ||
      !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot) ||
      !latestSelectedProvider.ok ||
      JSON.stringify(accountAccess) !== JSON.stringify(latestAccountAccess) ||
      codingPlanAuthorization !== (latestMaasJwt?.trim() ?? "")
    ) {
      continue;
    }

    // The provider entry is only a gate confirming that the Coding Plan connection exists. The business key is no longer a credential
    // (the flow switched to the MaaS JWT channel), so do not require it to be present; otherwise a transient key refresh
    // would classify a call that could succeed as “no plan.” The two gates above handle actual “no plan” cases:
    // API Key mode and the selected Start Plan connection, neither of which depends on the business key.
    const provider = identity.snapshot.registry.providers.find(
      (candidate) => candidate.providerId === selected.plan.providerId,
    );
    if (!provider) return fail("official_auth_plan_required");

    // Use info rather than debug: production builds do not persist debug logs, and the MaaS JWT remaining lifetime is important diagnostic context
    // (see createCredentialResolvedLogKey). Log only remaining seconds, never the token itself.
    // Log only when the deduplication key changes buckets, avoiding a log volume comparable to official MCP request volume.
    const maasJwtExpiresInSeconds = readJwtExpiresInSeconds(codingPlanAuthorization);
    const logKey = createCredentialResolvedLogKey({
      providerFamily: selected.plan.providerFamily,
      planTargetType: selected.plan.planScope?.targetType ?? null,
      maasJwtExpiresInSeconds,
    });
    if (logKey !== lastCredentialResolvedLogKey) {
      lastCredentialResolvedLogKey = logKey;
      log.info(undefined, "official mcp credentials resolved", {
        maasJwtExpiresInSeconds,
        providerFamily: selected.plan.providerFamily,
        planTargetType: selected.plan.planScope?.targetType ?? null,
        wireTargetType: selected.plan.wireScope?.targetType ?? null,
      });
    }

    return {
      ok: true,
      snapshot: {
        codingPlanAuthorization,
        jwt: identity.snapshot.jwt,
        planScope: selected.plan.planScope,
        providerFamily: selected.plan.providerFamily,
        wireScope: selected.plan.wireScope,
      },
    };
  }

  return fail("official_auth_unavailable");
}

/**
 * Build identity headers for this request from the credential snapshot.
 * Team identity is atomic as a pair: if either organization or project is missing, send neither.
 */
export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}`,
  };
  if (snapshot.codingPlanAuthorization) {
    // The server applies CutPrefix("Bearer ") and also accepts a bare token; send the Bearer form per the MCP API documentation.
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] =
      `Bearer ${snapshot.codingPlanAuthorization}`;
  }
  const scope = snapshot.wireScope;
  if (scope) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = scope.targetType;
    if (scope.targetType === "TEAM") {
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.organization] = scope.organizationId;
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.project] = scope.projectId;
    }
  }
  return headers;
}

/** Request context passed through by the host handler; not used to select credentials. */
export interface OfficialMcpAuthHeadersRequestContext {
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

export type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * Identity-header resolution entry point with in-flight deduplication.
 *
 * Coalesce **concurrent** requests only: later callers reuse the same Promise while a resolution is in flight; discard it immediately on settle,
 * and fully resolve again for the next request. There is no time-based cache and therefore no window for reading credentials that have since been replaced.
 * Scope is global to the host: credentials are global state, and bucketing by plugin/mcpKey/workspace would weaken deduplication without adding isolation.
 */
export function createOfficialMcpAuthHeadersResolver(deps: OfficialMcpCredentialResolverDeps): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  let pending: Promise<OfficialMcpAuthHeadersOutcome> | null = null;

  return {
    // request is present only for contract alignment (the host handler has already performed trust validation; see zcodeAgentService).
    // Credentials are global host state and are **not** bucketed by plugin/mcpKey/workspace; bucketing would weaken in-flight
    // deduplication without adding isolation. Keep the parameter so future audits do not require another interface change.
    resolveHeaders(_request?: OfficialMcpAuthHeadersRequestContext) {
      if (pending) return pending;
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        const outcome = await resolveOfficialMcpCredentials(deps);
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        return { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) };
      })();
      pending = inFlight;
      // Use then with both handlers instead of finally: finally creates a derived Promise that also rejects,
      // and callers await only inFlight, leaving that derived Promise unhandled.
      // Clear the slot on resolution errors too, or later requests will reuse the failed Promise forever.
      const clear = (): void => {
        if (pending === inFlight) pending = null;
      };
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
