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
  zcodeProviderAccountAccessSchema,
  type OfficialAuthConsumerKind,
  type OfficialMcpAuthFailureReason,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  isSameOAuthAccountMaterial,
  type OAuthAccountMaterial,
  type OAuthIdentityMaterial,
} from "#src/oauth/repo/oauthCredentialRepo.js";
import type { ModelSelectionView } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("official-mcp");

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

export interface OfficialMcpCredentialResolveOptions {
  /**
   * Plan-optional (plugin command process, design doc 5.8): when the selected connection has no
   * valid plan, do not return plan_required — only the ZCode login identity, letting the server
   * treat it as the free tier. An incomplete login state (missing MaaS JWT, cross-family) still
   * returns unavailable; never downgrade a paying user to free.
   */
  planOptional?: boolean;
}

export interface OfficialMcpCredentialResolverDeps {
  accountRequestAuthService: {
    resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  };
  getRegistryRevision(): number | null;
  loadOAuthIdentityMaterial(): Promise<OAuthIdentityMaterial | null>;
  loadOAuthAccountMaterial(family: "zai" | "bigmodel"): Promise<OAuthAccountMaterial | null>;
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
  providerFamily: "zai" | "bigmodel" | "zai_cn";
  /** Product/quota ownership of the currently selected connection; null when a malformed legacy Team key cannot be assigned precisely. */
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
  activeProvider: "zai" | "bigmodel" | "zai_cn";
  userId: string;
  sessionRevision: string | null;
  jwt: string;
  registry: ModelSelectionView;
  selectionFingerprint: string;
  registryRevision: number | null;
};

async function readIdentitySnapshot(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<
  | { ok: true; snapshot: OfficialMcpIdentitySnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason }
> {
  const registryRevision = deps.getRegistryRevision();
  const registry = await deps.modelSelectionService.getView();
  const identity = await deps.loadOAuthIdentityMaterial();
  // The Coding Plan Registry may switch while identity is read; no await after the synchronous version check.
  if (deps.getRegistryRevision() !== registryRevision) return fail("official_auth_unavailable");
  if (!identity) return fail("official_auth_unavailable");
  const activeProvider =
    identity.loginProvider === "zai"
      ? "zai"
      : identity.loginProvider === "bigmodel"
        ? "bigmodel"
        : identity.loginProvider === "zai_cn"
          ? "zai_cn"
          : null;
  if (!activeProvider) return fail("official_auth_unavailable");
  return {
    ok: true,
    snapshot: {
      activeProvider,
      userId: identity.zcodeUserId,
      sessionRevision: identity.sessionRevision,
      jwt: identity.zcodeJwtToken,
      registry,
      registryRevision,
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
    before.userId === after.userId &&
    before.sessionRevision === after.sessionRevision &&
    before.jwt === after.jwt &&
    before.registryRevision === after.registryRevision &&
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
 * Race protection: the Registry, dynamic Account Access, the active provider, the zcode JWT and the MaaS JWT
 * may all change during resolution. The login channel does not decide the plan family; the primary identity and the linked material must match the same
 * user ID, revision, and business JWT. Re-compare the selection and linked material before and after resolution; if two rounds remain unstable, return unavailable.
 */
export async function resolveOfficialMcpCredentials(
  deps: OfficialMcpCredentialResolverDeps,
  options: OfficialMcpCredentialResolveOptions = {},
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
    if (!selected.ok) {
      if (!options.planOptional || selected.reason !== "official_auth_plan_required") {
        return selected;
      }
      // Plan-optional: the selected Coding Plan connection currently has no valid plan (expired,
      // wrong type); treat it as login identity only. As with "no plan selected" above, first
      // confirm the identity did not change during resolution.
      const latestIdentity = await readIdentitySnapshot(deps);
      if (
        !latestIdentity.ok ||
        !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot)
      ) {
        continue;
      }
      return identityOnlyOutcome(identity.snapshot);
    }

    const material = await deps.loadOAuthAccountMaterial(selected.plan.providerFamily);
    // The login channel and the plan family may differ; only the linked material bound to the primary identity may be accepted.
    if (
      !material ||
      material.loginProvider !== identity.snapshot.activeProvider ||
      material.zcodeUserId !== identity.snapshot.userId ||
      material.sessionRevision !== identity.snapshot.sessionRevision ||
      material.zcodeJwtToken !== identity.snapshot.jwt
    )
      continue;
    const codingPlanAuthorization = material.accessToken.trim();
    if (!codingPlanAuthorization) return fail("official_auth_unavailable");
    const latestAccountAccess = await deps.accountRequestAuthService.resolveAccessCurrent(
      selectedProvider.provider.access,
    );
    const latestMaterial = await deps.loadOAuthAccountMaterial(selected.plan.providerFamily);
    // The last IO reads the primary identity and the Registry again, so after an account switch no stale plan header is assembled.
    const latestIdentity = await readIdentitySnapshot(deps);
    if (
      !latestIdentity.ok ||
      !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot) ||
      JSON.stringify(accountAccess) !== JSON.stringify(latestAccountAccess) ||
      !isSameOAuthAccountMaterial(material, latestMaterial)
    )
      continue;

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
  consumer: OfficialAuthConsumerKind;
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
  // The two consumers resolve differently (plan-optional or not); merge in-flight requests per mode.
  const pending = new Map<
    "plan-required" | "plan-optional",
    Promise<OfficialMcpAuthHeadersOutcome>
  >();

  return {
    // request only selects the resolution mode (the host handler has already done the trusted
    // validation before this, see zcodeAgentService);
    // Credentials are global host state and are **not** bucketed by plugin/mcpKey/workspace; bucketing would weaken in-flight
    // deduplication without adding isolation.
    resolveHeaders(request?: OfficialMcpAuthHeadersRequestContext) {
      const mode = request?.consumer === "plugin-command" ? "plan-optional" : "plan-required";
      const existing = pending.get(mode);
      if (existing) return existing;
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        const outcome = await resolveOfficialMcpCredentials(deps, {
          planOptional: mode === "plan-optional",
        });
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        return { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) };
      })();
      pending.set(mode, inFlight);
      // Use then with both handlers instead of finally: finally creates a derived Promise that also rejects,
      // and callers await only inFlight, leaving that derived Promise unhandled.
      // Clear the slot on resolution errors too, or later requests will reuse the failed Promise forever.
      const clear = (): void => {
        if (pending.get(mode) === inFlight) pending.delete(mode);
      };
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
