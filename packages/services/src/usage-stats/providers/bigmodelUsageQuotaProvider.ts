/* eslint-disable max-lines -- Quota, entitlement, and monitor requests share provider authentication logic; splitting the file would make Coding Plan strict-key boundaries harder to trace. */
import { z } from "zod";
import type {
  ApiClient,
  ApiRequestInit,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageMcpQuotaSnapshot,
  UsageQuotaLimit,
  UsageStatsRequest,
  UsageStatsSnapshot,
  ZCodeAccountAccess,
} from "@zcode/shared";
import {
  ApiError,
  BUILTIN_MODEL_PROVIDER_IDS,
  isCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  isZaiCodingPlanProviderId,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";
import type { ProviderFamilyDomain } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ICredentialService } from "../../credential/credential.js";
import type { IAccountRequestAuthService } from "../../model-provider/accountRequestAuthService.js";
import { readApiJson } from "../../providers/api/apiJson.js";
import { readEnv } from "../../oauth/providers/configUtils.js";
import {
  buildZaiStartPlanBalanceUrl,
  fetchZaiStartPlanBalanceEnvelope,
  type ZaiStartPlanBalanceEnvelope,
  type ZaiStartPlanPlan,
} from "../../model-provider/zaiStartPlanBilling.js";
import type {
  BigModelUsageModelUsagePayload,
  BigModelUsageModelUsageEnvelope,
  BigModelUsageToolUsagePayload,
  BigModelUsageToolUsageEnvelope,
  BigModelCreditUsageActivityPayload,
  BigModelCreditUsageActivityEnvelope,
  BigModelCreditUsageDetailPayload,
  BigModelCreditUsageDetailEnvelope,
  BigModelUsageModelPerformancePayload,
  BigModelUsageModelPerformanceEnvelope,
} from "./bigmodelUsageMonitorMapper.js";
import {
  buildCodingPlanUsageSnapshotFromMonitor,
  buildUsageStatsSnapshotFromMonitor,
} from "./bigmodelUsageMonitorMapper.js";
import {
  resolveCodingPlanUsageTimeRange,
  resolveUsageTimeRange,
} from "./bigmodelUsageMonitorRange.js";
import { fetchBigModelSubscriptionSummary } from "./bigmodelSubscriptionProvider.js";
import {
  fetchMcpQuotaSnapshot,
  type OfficialMcpCredentialSource,
} from "./zcodeMcpQuotaProvider.js";
import type { BigModelUsageQuotaEnvelope } from "./bigmodelUsageQuotaMapper.js";
import { normalizeLimits, pickPrimaryLimit } from "./bigmodelUsageQuotaMapper.js";

const BIGMODEL_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const CODING_PLAN_RESET_BASE_PATH = "/api/v1/coding-plan/reset";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ZAI_OAUTH_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
const BIGMODEL_OAUTH_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");
const EMPTY_MODEL_USAGE_PAYLOAD = {} satisfies BigModelUsageModelUsagePayload;
const EMPTY_TOOL_USAGE_PAYLOAD = {} satisfies BigModelUsageToolUsagePayload;
const EMPTY_CREDIT_ACTIVITY_PAYLOAD = {} satisfies BigModelCreditUsageActivityPayload;
const EMPTY_CREDIT_DETAIL_PAYLOAD = {} satisfies BigModelCreditUsageDetailPayload;
const EMPTY_MODEL_PERFORMANCE_PAYLOAD = {} satisfies BigModelUsageModelPerformancePayload;

const codingPlanResetEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});
const codingPlanResetOpportunitySchema = z.object({
  expire_at: z.number().finite().positive(),
});
const codingPlanResetHistorySchema = z.object({
  used_at: z.number().finite().positive(),
});
const codingPlanResetStatusDataSchema = z.object({
  available_five_hour_resets: z.array(codingPlanResetOpportunitySchema),
  available_week_resets: z.array(codingPlanResetOpportunitySchema),
  latest_five_hour_reset_history: codingPlanResetHistorySchema.nullable(),
  latest_week_reset_history: codingPlanResetHistorySchema.nullable(),
  has_unread_history: z.boolean(),
});
const codingPlanResetUseDataSchema = z.object({
  used: z.literal(true),
});
const codingPlanResetOpportunityGrantedDataSchema = z.object({
  granted: z.literal(true),
});
const codingPlanResetOpportunityDeniedDataSchema = z.object({
  granted: z.literal(false),
  next_try_at: z.number().int().positive(),
});

export interface UsageApiAuthorizationRequest {
  readonly preferredProviderId?: string;
  readonly requirePreferredProvider: boolean;
}

export interface UsageApiAuthorization {
  readonly authorization: string;
  readonly quotaUrl: string;
  readonly provider: ResolvedQuotaAuthorization["provider"];
}

interface BigModelUsageQuotaProviderOptions {
  apiClient: ApiClient;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  /**
   * Credential source for the official Server MCP. When omitted, mcpQuota in the entitlement snapshot is always null,
   * preserving existing assembly behavior, including tests.
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

interface ResolvedQuotaAuthorization {
  authorization: string;
  quotaUrl: string;
  teamContext: TeamPlanContext | null;
  provider: {
    id: string;
    name: string;
  };
}

interface TeamPlanContext {
  organizationId: string;
  projectId: string;
  // Team Plan usage queries exist symmetrically for the zai/bigmodel families,
  // but the host, OAuth token key, and authorization header for copied team-project API keys are family-specific.
  // Pass the family so downstream resolveTeamPlanProjectApiKey can select the correct zai/bigmodel business domain and token.
  family: ProviderFamilyDomain;
}

interface CodingPlanResetAuthorization {
  zcodeAuthorization: string;
  codingPlanAuthorization: string;
  teamContext: TeamPlanContext | null;
}

// Reuse the response type directly so a local copy cannot omit new bucket/period fields.
type ZaiStartPlanBalance = NonNullable<
  NonNullable<ZaiStartPlanBalanceEnvelope["data"]>["balances"]
>[number];

export class BigModelUsageQuotaProvider {
  private readonly apiClient: ApiClient;
  private readonly accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  private readonly resolveApiAuthorization?: BigModelUsageQuotaProviderOptions["resolveApiAuthorization"];
  private readonly credentialService?: Pick<ICredentialService, "load">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly officialMcpCredentialSource?: OfficialMcpCredentialSource;

  constructor(options: BigModelUsageQuotaProviderOptions) {
    this.apiClient = options.apiClient;
    this.accountRequestAuthService = options.accountRequestAuthService;
    this.resolveApiAuthorization = options.resolveApiAuthorization;
    this.credentialService = options.credentialService;
    this.env = options.env ?? process.env;
    this.officialMcpCredentialSource = options.officialMcpCredentialSource;
  }

  async getSnapshot(): Promise<UsageEntitlementSnapshot> {
    return this.getSnapshotForRequest({});
  }

  async getSnapshotForRequest(
    request: UsageEntitlementRequest = {},
  ): Promise<UsageEntitlementSnapshot> {
    // The settings page can obtain only static family/mode from Registry. Read dynamic planKind and Team scope
    // from the current account connection at the service boundary; do not ask the UI to fabricate dynamic entitlement facts from Effective Config.
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    const resolvedRequest: UsageEntitlementRequest = {
      ...request,
      accountAccess,
    };
    if (request.preferredProviderId && isStartPlanModelProviderId(request.preferredProviderId)) {
      return this.getStartPlanSnapshot(
        request.preferredProviderId,
        accountAccess,
        request.invalidateBalanceCache,
      );
    }

    const generatedAt = Date.now();
    const teamContext = accountAccess ? resolveTeamPlanContext(accountAccess) : null;
    const providerId = request.preferredProviderId?.trim() ?? "";
    // Team entitlements do not require a call Key; preserve a confirmed subscription even if creating/copying the Key fails.
    const teamEntitlement = teamContext
      ? await fetchBigModelSubscriptionSummary({
          apiClient: this.apiClient,
          authorization: "",
          quotaUrl:
            resolveQuotaUrlFromEnv(this.env) ??
            (teamContext.family === "zai"
              ? buildZaiQuotaUrl(this.env)
              : buildBigModelQuotaUrl(this.env)),
          teamContext,
          businessToken: await this.credentialService?.load(
            `oauth:${teamContext.family}:access_token`,
          ),
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      : null;
    let resolved: ResolvedQuotaAuthorization | null = null;
    try {
      resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        accountAccess,
        requirePreferredProvider: request.requirePreferredProvider === true,
        allowEnvApiKey: request.allowEnvApiKey,
      });
    } catch (error) {
      log.warn(undefined, "读取用量凭据失败，保留独立订阅判定", {
        error: error instanceof Error ? error.message : String(error),
        preferredProviderId: providerId,
      });
    }
    const entitlement =
      teamEntitlement ??
      (resolved
        ? await fetchBigModelSubscriptionSummary({
            apiClient: this.apiClient,
            authorization: resolved.authorization,
            quotaUrl: resolved.quotaUrl,
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
        : { kind: "unknown" as const });
    // Do not publish an unknown subscription as a successful empty snapshot; the hook would overwrite confirmed entitlements for the same identity and clear failure backoff.
    // An unconfigured state with no credentials still returns normally; when query identity exists, use the shared failure path to preserve the snapshot.
    if (entitlement.kind === "unknown" && (resolved || teamContext)) {
      throw new Error("Coding Plan entitlement refresh failed");
    }
    const subscription =
      entitlement.kind !== "available" ? null : buildSubscriptionSnapshot(entitlement.subscription);
    const [payload, mcpQuota] = resolved
      ? await Promise.all([
          this.fetchQuota(resolved).catch(() => null),
          this.fetchMcpQuota(resolved).catch(() => null),
        ])
      : [null, null];
    // Quota failure or level presence does not change entitlements; exhausted quota affects usage display only.
    const quotaData = payload && isSuccessfulBigModelEnvelope(payload) ? payload.data : null;
    const limits = normalizeLimits(quotaData?.limits);
    const primaryLimit = pickPrimaryLimit(limits);
    if (accountAccess && providerId) {
      await this.accountRequestAuthService.assertCurrent({
        providerId,
        accountAccess,
      });
    }
    return {
      generatedAt,
      authenticated: true,
      ...(entitlement.kind === "available"
        ? {}
        : {
            unavailableReason:
              entitlement.kind === "unavailable"
                ? ("no_plan" as const)
                : resolved || teamContext
                  ? ("unavailable" as const)
                  : ("not_configured" as const),
          }),
      ...(teamEntitlement?.kind === "unavailable" && teamEntitlement.reason
        ? { teamPlanUnavailableReason: teamEntitlement.reason }
        : {}),
      context: resolved
        ? buildUsageEntitlementContext(resolved, subscription)
        : buildUsageEntitlementContextFromRequest(resolvedRequest),
      provider: resolved?.provider ?? null,
      remaining: primaryLimit
        ? {
            count: primaryLimit.remaining ?? 0,
            isShow: true,
            percentage: primaryLimit.percentage,
            nextResetTime: primaryLimit.nextResetTime ?? null,
          }
        : null,
      subscription,
      quota: quotaData ? { level: quotaData.level?.trim() || null, limits } : null,
      mcpQuota,
    };
  }

  private async resolveRequestAccountAccess(
    accountAccess: UsageEntitlementRequest["accountAccess"],
  ): Promise<ZCodeAccountAccess | undefined> {
    if (!accountAccess) return undefined;
    if (!("mode" in accountAccess)) return accountAccess;
    return (await this.accountRequestAuthService.resolveAccessCurrent(accountAccess)) ?? undefined;
  }

  /**
   * Read the official Server MCP quota. Only the Coding Plan provider makes this request:
   * environment-variable keys, regular API Key providers, and Start Plan do not have this entitlement.
   */
  private async fetchMcpQuota(
    resolved: ResolvedQuotaAuthorization,
  ): Promise<UsageMcpQuotaSnapshot | null> {
    if (!this.officialMcpCredentialSource) {
      return null;
    }
    if (!isCodingPlanModelProviderId(resolved.provider.id)) {
      return null;
    }
    return fetchMcpQuotaSnapshot({
      apiClient: this.apiClient,
      credentialSource: this.officialMcpCredentialSource,
      env: this.env,
      requestScope: {
        providerFamily:
          resolved.teamContext?.family ??
          (isZaiCodingPlanProviderId(resolved.provider.id) ? "zai" : "bigmodel"),
        organizationId: resolved.teamContext?.organizationId ?? null,
        projectId: resolved.teamContext?.projectId ?? null,
      },
    });
  }

  private async getStartPlanSnapshot(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
    invalidateBalanceCache = false,
  ): Promise<UsageEntitlementSnapshot> {
    const generatedAt = Date.now();
    const resolved = await this.resolveStartPlanAuthorization(providerId, accountAccess);
    if (!resolved) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "not_configured",
        context: { scope: "personal" },
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

    let balancePayload: ZaiStartPlanBalanceEnvelope;
    try {
      const balanceUrl = buildZaiStartPlanBalanceUrl();
      const balanceStartedAt = Date.now();
      // billing/current is deprecated; balance returns both plans and balances.
      // The Start Plan snapshot must make only one balance request, avoiding duplicate requests on cold start and continued dependence on the old endpoint.
      balancePayload = await fetchZaiStartPlanBalanceEnvelope(
        this.apiClient,
        resolved.authorization,
        invalidateBalanceCache,
      );
      log.info(undefined, "billing/balance 请求完成", {
        balanceCount: balancePayload.data?.balances?.length ?? 0,
        balances: summarizeStartPlanBalances(balancePayload.data?.balances),
        code: balancePayload.code ?? null,
        durationMs: Date.now() - balanceStartedAt,
        msg: balancePayload.msg ?? null,
        payload: balancePayload,
        planCount: balancePayload.data?.plans?.length ?? 0,
        plans: summarizeStartPlans(balancePayload.data?.plans),
        providerId,
        success: balancePayload.code === 0,
        url: balanceUrl,
      });
    } catch (error) {
      log.warn(undefined, "billing/balance 请求失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
        responseHeaders: error instanceof ApiError ? (error.responseHeaders ?? null) : null,
        status: error instanceof ApiError ? error.status : null,
        url: buildZaiStartPlanBalanceUrl(),
      });
      // Preserve HTTP 429 and other error information so callers can back off and retain confirmed entitlements.
      throw error;
    }

    if (balancePayload.code !== 0) {
      throw new Error(balancePayload.msg || `Start Plan balance failed: ${balancePayload.code}`);
    }

    const currentPlan = pickCurrentZaiStartPlan(balancePayload.data?.plans);
    if (!currentPlan) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "no_plan",
        startPlanExpired:
          balancePayload.data?.plans?.some((plan) => plan.status?.toLowerCase() === "expired") ??
          false,
        context: { scope: "personal" },
        provider: resolved.provider,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

    warnOnUnattributedStartPlanBuckets(
      balancePayload.data?.plans,
      readZaiStartPlanBalances(balancePayload),
    );

    return {
      generatedAt,
      authenticated: true,
      context: { scope: "personal" },
      provider: resolved.provider,
      // Pair the server time from balance with this response's effective_at; do not overwrite it with the local clock.
      ...(typeof balancePayload.data?.server_time === "number" &&
      Number.isFinite(balancePayload.data.server_time) &&
      balancePayload.data.server_time >= 0
        ? { serverTime: balancePayload.data.server_time * 1_000 }
        : {}),
      remaining: buildZaiStartPlanRemaining(readZaiStartPlanBalances(balancePayload)),
      subscription: buildZaiStartPlanSubscription(balancePayload.data?.plans),
      quota: buildZaiStartPlanQuota(
        readZaiStartPlanBalances(balancePayload),
        balancePayload.data?.plans,
      ),
    };
  }

  private async resolveStartPlanAuthorization(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
  ): Promise<{
    authorization: string;
    provider: ResolvedQuotaAuthorization["provider"];
  } | null> {
    if (!accountAccess || accountAccess.planKind !== "start-plan") {
      return null;
    }
    let auth;
    try {
      auth = await this.accountRequestAuthService.resolveCurrent({
        providerId,
        accountAccess,
        reason: "usage",
      });
    } catch {
      return null;
    }
    const apiKey = auth.apiKey?.trim() ?? "";
    if (!apiKey) return null;

    return {
      authorization: /^Bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`,
      provider: {
        id: providerId,
        name: resolveAccountProviderLabel(providerId),
      },
    };
  }

  async getUsageStatsSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: request.requirePreferredProvider === true,
      allowEnvApiKey: request.allowEnvApiKey,
    });
    if (!resolved) {
      // Settings usage statistics can be explicitly scoped to the Coding Plan provider.
      // When a provider is specified strictly, do not fall back to a regular API Key, environment variable, or local session aggregation.
      throw new Error("no_bigmodel_api_key");
    }

    const { startTime, endTime } = resolveUsageTimeRange(request);
    const [modelPayload, toolPayload] = await Promise.all([
      this.fetchModelUsage(resolved, startTime, endTime),
      this.fetchToolUsage(resolved, startTime, endTime),
    ]);

    const modelData = readSuccessfulBigModelMonitorData(
      modelPayload,
      "BigModel model usage failed",
      EMPTY_MODEL_USAGE_PAYLOAD,
    );
    const toolData = readSuccessfulBigModelMonitorData(
      toolPayload,
      "BigModel tool usage failed",
      EMPTY_TOOL_USAGE_PAYLOAD,
      { allowMissingData: true },
    );

    return {
      ...buildUsageStatsSnapshotFromMonitor(request, modelData, toolData),
      sourceProvider: resolved.provider,
    };
  }

  async getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/status`),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createCodingPlanResetHeaders(authorization, true),
      },
    );
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetStatusDataSchema);
    return {
      availableFiveHourResets: data.available_five_hour_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      availableWeekResets: data.available_week_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      latestFiveHourResetHistory: data.latest_five_hour_reset_history
        ? { usedAt: data.latest_five_hour_reset_history.used_at }
        : null,
      latestWeekResetHistory: data.latest_week_reset_history
        ? { usedAt: data.latest_week_reset_history.used_at }
        : null,
      hasUnreadHistory: data.has_unread_history,
    };
  }

  async useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/use`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: {
          ...createCodingPlanResetHeaders(authorization, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          reset_type: request.resetType,
        }),
      },
    );
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetUseDataSchema);
    return { used: data.used };
  }

  async requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    let payload: unknown;
    try {
      payload = await readCodingPlanResetApiJson(
        this.apiClient,
        buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/opportunity`),
        {
          method: "POST",
          timeoutMs: REQUEST_TIMEOUT_MS,
          headers: {
            ...createCodingPlanResetHeaders(authorization, true),
            "content-type": "application/json",
          },
          body: JSON.stringify({ idempotency_key: idempotencyKey }),
        },
        { acceptedBusinessCodes: [3301] },
      );
    } catch (error) {
      // The backend returns HTTP 429 directly for rapid requests/card-lock contention, without a 3301 envelope or next_try_at.
      // Map it to a stable error code so the client can apply fallback cooldown and avoid repeated rate limits during 30-second polling.
      if (error instanceof ApiError && error.status === 429) {
        throw new Error("coding_plan_reset_opportunity_throttled", {
          cause: error,
        });
      }
      throw error;
    }
    const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new Error("coding_plan_reset_invalid_response");
    }
    // next_try_at for 3301 is the server's rate-limit boundary and must be passed through to the client in full.
    // Dropping this field makes 30-second polling repeatedly check eligibility and bypass the backend's required retry interval.
    if (envelope.data.code === 3301) {
      const denied = codingPlanResetOpportunityDeniedDataSchema.safeParse(envelope.data.data);
      if (!denied.success) {
        throw new Error("coding_plan_reset_invalid_response");
      }
      return { granted: false, nextTryAt: denied.data.next_try_at };
    }
    const data = readCodingPlanResetEnvelopeData(
      payload,
      codingPlanResetOpportunityGrantedDataSchema,
    );
    return { granted: data.granted, nextTryAt: null };
  }

  async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/history/read`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        // history/read authenticates with the current Coding Plan credential but uses a user-shared read cursor, without target scope.
        headers: createCodingPlanResetHeaders(authorization, false),
      },
    );
    readCodingPlanResetEnvelope(payload);
  }

  private async resolveCodingPlanResetAuthorization(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetAuthorization> {
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    if (!accountAccess) {
      throw new Error("coding_plan_reset_account_access_required");
    }
    await this.accountRequestAuthService.assertCurrent({
      providerId: request.preferredProviderId,
      accountAccess,
    });
    const zcodeJwt = (await this.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (!zcodeJwt) {
      throw new Error("coding_plan_reset_zcode_jwt_required");
    }
    // reset supports both Z.ai and BigModel Coding Plan. Always reading oauth:bigmodel:access_token
    // makes requests from users logged in only to Z.ai fail before sending. Select the business JWT strictly by the current provider family
    // and forbid cross-family fallback. Pass the header through according to the backend contract without a Bearer prefix.
    const codingPlanJwtKey =
      accountAccess.family === "zai" ? ZAI_OAUTH_ACCESS_TOKEN_KEY : BIGMODEL_OAUTH_ACCESS_TOKEN_KEY;
    const codingPlanJwt = (await this.credentialService?.load(codingPlanJwtKey))?.trim() ?? "";
    if (!codingPlanJwt) {
      throw new Error("coding_plan_reset_maas_jwt_required");
    }
    return {
      zcodeAuthorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
      codingPlanAuthorization: codingPlanJwt,
      teamContext: resolveTeamPlanContext(accountAccess),
    };
  }

  async getCodingPlanUsageSnapshot(
    request: CodingPlanUsageRequest,
  ): Promise<CodingPlanUsageSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    if (!resolved) {
      // Coding Plan usage now uses the API Key from the corresponding Coding Plan provider directly.
      // If absent, do not fall back to a regular API Key, environment variable, OAuth, or local App Usage.
      throw new Error(resolveCodingPlanApiKeyError(request.preferredProviderId));
    }

    const usageRange = resolveCodingPlanUsageTimeRange(request);
    // Monitor requests must not be all-or-nothing. Keep the existing required-success semantics for quota
    // (a transport failure fails the whole request; a business failure degrades to quota: null). activity/detail/health
    // are optional data surfaces; on transport failure, clear only the affected area and log a warning so one failure does not take down the whole panel.
    const [quotaPayload, activityData, modelDetailData, toolDetailData, health7dData] =
      await Promise.all([
        this.fetchQuota(resolved),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageActivity(resolved, request.timeZone),
          "BigModel activity usage failed",
          EMPTY_CREDIT_ACTIVITY_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageDetail(resolved, usageRange.startTime, usageRange.endTime, "MODEL"),
          "BigModel model usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageDetail(resolved, usageRange.startTime, usageRange.endTime, "MCP"),
          "BigModel tool usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchModelPerformanceDay(resolved, request.timeZone, "7d"),
          "BigModel model performance failed",
          EMPTY_MODEL_PERFORMANCE_PAYLOAD,
        ),
      ]);

    const quota =
      isSuccessfulBigModelEnvelope(quotaPayload) && quotaPayload.data
        ? {
            level: quotaPayload.data.level?.trim() || null,
            limits: normalizeLimits(quotaPayload.data.limits),
          }
        : null;

    return buildCodingPlanUsageSnapshotFromMonitor({
      request,
      provider: resolved.provider,
      quota,
      granularity: usageRange.granularity,
      xTime: usageRange.xTime,
      startDateKey: usageRange.startDateKey,
      endDateKey: usageRange.endDateKey,
      activityData,
      modelDetailData,
      toolDetailData,
      healthData: health7dData,
    });
  }

  private async resolveAuthorization(
    request: {
      preferredProviderId?: string;
      accountAccess?: UsageEntitlementRequest["accountAccess"];
      requirePreferredProvider?: boolean;
      allowEnvApiKey?: boolean;
    } = {},
  ): Promise<ResolvedQuotaAuthorization | null> {
    if (request.allowEnvApiKey !== false && request.requirePreferredProvider !== true) {
      const envApiKey =
        readEnv(this.env, "ZCODE_BIGMODEL_USAGE_API_KEY") ??
        readEnv(this.env, "BIGMODEL_USAGE_API_KEY");
      if (envApiKey) {
        return {
          authorization: envApiKey,
          quotaUrl: resolveQuotaUrlFromEnv(this.env) ?? buildBigModelQuotaUrl(this.env),
          teamContext: null,
          provider: {
            id: "env:bigmodel-usage",
            name: "BigModel",
          },
        };
      }
    }

    const providerId = request.preferredProviderId?.trim() ?? "";
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    if (providerId && isCodingPlanModelProviderId(providerId)) {
      if (!accountAccess) return null;
      const auth = await this.accountRequestAuthService.resolveCurrent({
        providerId,
        accountAccess,
        reason: "usage",
      });
      const authorization = auth.apiKey?.trim() ?? "";
      if (!authorization) return null;
      return {
        authorization,
        quotaUrl:
          resolveQuotaUrlFromEnv(this.env) ?? resolveAccountProviderQuotaUrl(providerId, this.env),
        teamContext: resolveTeamPlanContext(accountAccess),
        provider: {
          id: providerId,
          name: resolveAccountProviderLabel(providerId),
        },
      };
    }

    const apiAuthorization = await this.resolveApiAuthorization?.({
      preferredProviderId: providerId || undefined,
      requirePreferredProvider: request.requirePreferredProvider === true,
    });
    return apiAuthorization ? { ...apiAuthorization, teamContext: null } : null;
  }

  private async fetchQuota(
    resolved: ResolvedQuotaAuthorization,
  ): Promise<BigModelUsageQuotaEnvelope> {
    return readApiJson<BigModelUsageQuotaEnvelope>(this.apiClient, buildQuotaLimitUrl(resolved), {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    });
  }

  private async fetchModelUsage(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
  ): Promise<BigModelUsageModelUsageEnvelope> {
    return readApiJson<BigModelUsageModelUsageEnvelope>(
      this.apiClient,
      buildUsageMonitorUrl(resolved, "model-usage", startTime, endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchToolUsage(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
  ): Promise<BigModelUsageToolUsageEnvelope> {
    return readApiJson<BigModelUsageToolUsageEnvelope>(
      this.apiClient,
      buildUsageMonitorUrl(resolved, "tool-usage", startTime, endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchCreditUsageActivity(
    resolved: ResolvedQuotaAuthorization,
    timeZone: string | undefined,
  ): Promise<BigModelCreditUsageActivityEnvelope> {
    const range = resolveCreditUsageActivityTimeRange(timeZone);
    return readApiJson<BigModelCreditUsageActivityEnvelope>(
      this.apiClient,
      buildCreditUsageMonitorUrl(resolved, "activity", range.startTime, range.endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchCreditUsageDetail(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
    usageType: "MODEL" | "MCP",
  ): Promise<BigModelCreditUsageDetailEnvelope> {
    return readApiJson<BigModelCreditUsageDetailEnvelope>(
      this.apiClient,
      buildCreditUsageMonitorUrl(resolved, "usage-detail", startTime, endTime, usageType),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchModelPerformanceDay(
    resolved: ResolvedQuotaAuthorization,
    timeZone: string | undefined,
    range: "7d" | "30d",
  ): Promise<BigModelUsageModelPerformanceEnvelope> {
    const timeRange = resolveModelPerformanceTimeRange(timeZone, range);
    return readApiJson<BigModelUsageModelPerformanceEnvelope>(
      this.apiClient,
      buildModelPerformanceMonitorUrl(resolved, timeRange.startTime, timeRange.endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }
}

function createCodingPlanResetHeaders(
  authorization: CodingPlanResetAuthorization,
  includeTargetScope: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authorization.zcodeAuthorization,
    "X-Bigmodel-Authorization": authorization.codingPlanAuthorization,
  };
  if (!includeTargetScope) {
    return headers;
  }
  headers["Bigmodel-Target-Type"] = authorization.teamContext ? "TEAM" : "PERSONAL";
  if (authorization.teamContext) {
    headers["Bigmodel-Organization"] = authorization.teamContext.organizationId;
    headers["Bigmodel-Project"] = authorization.teamContext.projectId;
  }
  return headers;
}

function readCodingPlanResetErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "msg", "detail"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function readCodingPlanResetDiagnosticHeaders(
  headers: Headers,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const name of ["x-request-id", "x-trace-id", "x-span-id"] as const) {
    const value = headers.get(name)?.trim();
    if (value) {
      result[name] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Integration-diagnostics suffix: for envelope business errors (such as dependency failure 2007), include the backend x-request-id
// in the error message so RPC logs and UI warnings can be matched to backend logs by request id.
// Used only for log correlation; clients do not branch on it. Return an empty string when absent to preserve the message contract.
function readCodingPlanResetErrorDiagnostics(headers: Headers): string {
  const requestId = headers.get("x-request-id")?.trim();
  return requestId ? ` (x-request-id:${requestId})` : "";
}

async function readCodingPlanResetApiJson(
  apiClient: ApiClient,
  input: string,
  init: ApiRequestInit,
  options: { acceptedBusinessCodes?: readonly number[] } = {},
): Promise<unknown> {
  const response = await apiClient.request(input, init);
  let payload: unknown;
  let parseError: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    parseError = error;
  }

  // The reset backend still returns a stable business code in the standard envelope for HTTP 4xx.
  // Read code first; do not use the changeable msg as a client branching condition.
  const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (envelope.success && envelope.data.code !== 0) {
    if (options.acceptedBusinessCodes?.includes(envelope.data.code)) {
      return payload;
    }
    throw new Error(
      `coding_plan_reset_api_error:${envelope.data.code}${readCodingPlanResetErrorDiagnostics(response.headers)}`,
    );
  }

  if (!response.ok) {
    throw new ApiError({
      message: readCodingPlanResetErrorMessage(payload, `HTTP ${response.status}`),
      url: input,
      method: init.method,
      status: response.status,
      responseHeaders: readCodingPlanResetDiagnosticHeaders(response.headers),
      cause: parseError,
    });
  }
  if (parseError !== undefined) {
    throw new Error("coding_plan_reset_invalid_response", {
      cause: parseError,
    });
  }
  return payload;
}

function readCodingPlanResetEnvelope(
  payload: unknown,
): z.infer<typeof codingPlanResetEnvelopeSchema> {
  const result = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  if (result.data.code !== 0) {
    throw new Error(`coding_plan_reset_api_error:${result.data.code}`);
  }
  return result.data;
}

function readCodingPlanResetEnvelopeData<TSchema extends z.ZodType>(
  payload: unknown,
  schema: TSchema,
): z.infer<TSchema> {
  const envelope = readCodingPlanResetEnvelope(payload);
  const result = schema.safeParse(envelope.data);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  return result.data;
}

function resolveTeamPlanContext(accountAccess: ZCodeAccountAccess): TeamPlanContext | null {
  return accountAccess.planKind === "team-coding-plan"
    ? {
        organizationId: accountAccess.organizationId,
        projectId: accountAccess.projectId,
        family: accountAccess.family,
      }
    : null;
}

function buildUsageEntitlementContextFromRequest(
  request: Pick<UsageEntitlementRequest, "accountAccess">,
): UsageEntitlementSnapshot["context"] {
  if (
    !request.accountAccess ||
    !("planKind" in request.accountAccess) ||
    request.accountAccess.planKind !== "team-coding-plan"
  ) {
    return { scope: "personal" };
  }
  return {
    scope: "team",
    organizationId: request.accountAccess.organizationId,
    projectId: request.accountAccess.projectId,
  };
}

function buildUsageEntitlementContext(
  resolved: ResolvedQuotaAuthorization,
  subscription: UsageEntitlementSnapshot["subscription"],
): UsageEntitlementSnapshot["context"] {
  if (!resolved.teamContext) {
    return {
      scope: "personal",
      productId: subscription?.details[0]?.productId || null,
      displayName: subscription?.details[0]?.productName || null,
    };
  }
  return {
    scope: "team",
    organizationId: resolved.teamContext.organizationId,
    projectId: resolved.teamContext.projectId,
    productId: subscription?.details[0]?.productId || null,
    displayName: subscription?.details[0]?.productName || null,
  };
}

function createBigModelUsageHeaders(resolved: ResolvedQuotaAuthorization): Record<string, string> {
  const headers: Record<string, string> = {
    // Monitor endpoints require the full credential directly in authorization.
    // Regular usage and Coding Plan usage both use API Keys, so do not add a Bearer prefix.
    authorization: resolved.authorization,
  };
  if (resolved.teamContext) {
    // Team Plan quota/usage is isolated by organization and project.
    // Using only provider id always reads the default project, so balances will not match the current selection when multiple teams exist.
    headers["bigmodel-organization"] = resolved.teamContext.organizationId;
    headers["bigmodel-project"] = resolved.teamContext.projectId;
  }
  return headers;
}

function buildQuotaLimitUrl(resolved: ResolvedQuotaAuthorization): string {
  if (!resolved.teamContext) {
    return resolved.quotaUrl;
  }

  // The backend routes BigModel Team Plan quota/limit to the team plan with type=2.
  // Switching only the team-project key/header still uses the personal Coding Plan branch and returns “current user has no coding plan.”
  const url = new URL(resolved.quotaUrl);
  url.searchParams.set("type", "2");
  return url.toString();
}

function readSuccessfulBigModelMonitorData<TData extends object>(
  payload: {
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  },
  fallbackMessage: string,
  emptyData: TData,
  options: { allowMissingData?: boolean } = {},
): TData {
  if (!isSuccessfulBigModelEnvelope(payload)) {
    throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
  }
  if (payload.data) {
    return payload.data;
  }
  if (options.allowMissingData === true && hasExplicitBigModelSuccessSignal(payload)) {
    // BigModel monitor tool-usage omits data when a team project has no tool calls, while returning
    // code=200 and msg=“success.” Display empty usage statistics rather than interrupting the statistics page.
    return emptyData;
  }
  throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
}

// credit-usage/activity, usage-detail, and model-performance-day are optional data surfaces.
// On transport failure (non-2xx HTTP, timeout, offline), clear only the relevant area and warn; do not let Promise.all reject
// early and take down the entire Coding Plan Usage panel. If HTTP 200 carries a failed business envelope (such as token expired),
// readSuccessfulBigModelMonitorData still throws: authentication/backend errors must be exposed to users, not disguised as empty usage (existing tests lock in this behavior).
async function readBestEffortBigModelMonitorData<TData extends object>(
  request: Promise<{
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  }>,
  fallbackMessage: string,
  emptyData: TData,
): Promise<TData> {
  let payload: Awaited<typeof request> | null = null;
  try {
    payload = await request;
  } catch (error) {
    log.warn(undefined, `${fallbackMessage}，该区域降级为空统计`, {
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof ApiError ? error.status : null,
    });
    return emptyData;
  }
  return readSuccessfulBigModelMonitorData(payload, fallbackMessage, emptyData, {
    allowMissingData: true,
  });
}

function readBigModelEnvelopeMessage(payload: { message?: string; msg?: string }): string {
  return payload.msg?.trim() || payload.message?.trim() || "";
}

function hasExplicitBigModelSuccessSignal(payload: { code?: number; success?: boolean }): boolean {
  return payload.success === true || payload.code === 0 || payload.code === 200;
}

function isSuccessfulBigModelEnvelope(payload: { code?: number; success?: boolean }): boolean {
  const code = payload.code;
  // BigModel monitor/quota endpoints may return success with code=0 and msg=“success.”
  // Checking only code=200 would throw for valid team usage results and make the settings page report unreadable statistics.
  return (
    payload.success !== false && (code === undefined || code === null || code === 0 || code === 200)
  );
}

function buildSubscriptionSnapshot(summary: {
  productId: string;
  productName: string;
  billingCycle: string | null;
  renewTime: string | null;
  expireTime: string | null;
}): UsageEntitlementSnapshot["subscription"] {
  return {
    identityType: "unknown",
    identityMasked: null,
    details: [{ ...summary, purchaseTime: null, beginTime: null }],
  };
}

function buildZaiStartPlanSubscription(
  plans: ZaiStartPlanPlan[] | undefined,
): UsageEntitlementSnapshot["subscription"] {
  const activePlans = (plans ?? []).filter(
    (plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active",
  );
  return {
    identityType: "unknown",
    identityMasked: null,
    details: activePlans.map((plan) => ({
      productId: readNonEmptyString(plan.plan_id) ?? "",
      productName: readNonEmptyString(plan.name) ?? "编程套餐",
      purchaseTime: null,
      beginTime: formatUnixSecondsAsIso(plan.starts_at),
      billingCycle: pickZaiStartPlanBillingCycle(plan),
      // Start Plan cards do not show plan-level renewal time: each limit's nextResetTime (balance.expires_at) indicates when a quota bucket refreshes,
      // while expireTime (ends_at) indicates when the plan ends.
      renewTime: null,
      expireTime: formatUnixSecondsAsIso(plan.ends_at),
      entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
        const entitlementId = readNonEmptyString(entitlement.entitlement_id);
        if (!entitlementId) return [];
        return [
          {
            entitlementId,
            showName: readNonEmptyString(entitlement.show_name),
            effectiveTime: formatUnixSecondsAsIso(entitlement.effective_at),
          },
        ];
      }),
    })),
  };
}

/**
 * Tripwire: the server contract guarantees balances belong only to active plans and each bucket can be assigned to a plan card by
 * plan_id. An unassigned bucket (including one with no plan_id) means the contract is broken; the settings page's multi-card path would silently drop it.
 * Expose this explicitly in the provider so “where did my quota go?” issues are traceable. Valid data produces no log; use warn so production can see violations.
 */
function warnOnUnattributedStartPlanBuckets(
  plans: ZaiStartPlanPlan[] | undefined,
  balances: ZaiStartPlanBalance[] | undefined,
): void {
  const activePlanIds = new Set(
    (plans ?? [])
      .filter((plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active")
      .map((plan) => readNonEmptyString(plan.plan_id))
      .filter((planId): planId is string => Boolean(planId)),
  );
  const orphanBuckets = (balances ?? []).filter((balance) => {
    const planId = readNonEmptyString(balance.plan_id);
    return !planId || !activePlanIds.has(planId);
  });
  if (orphanBuckets.length === 0) {
    return;
  }
  log.warn(undefined, "billing/balance 返回无法归属到 active 套餐的额度桶", {
    orphanCount: orphanBuckets.length,
    orphanPlanIds: orphanBuckets.map((balance) => balance.plan_id ?? null),
    activePlanIds: [...activePlanIds],
  });
}

function buildZaiStartPlanRemaining(
  balances: ZaiStartPlanBalance[] | undefined,
): UsageEntitlementSnapshot["remaining"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances);
  if (limits.length === 0) {
    return null;
  }

  const total = limits.reduce((sum, limit) => sum + (limit.number ?? 0), 0);
  const remaining = limits.reduce((sum, limit) => sum + (limit.remaining ?? 0), 0);
  return {
    count: remaining,
    isShow: true,
    percentage: total > 0 ? remaining / total : undefined,
    nextResetTime:
      limits
        .map((limit) => limit.nextResetTime)
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => left - right)[0] ?? null,
  };
}

function buildZaiStartPlanQuota(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageEntitlementSnapshot["quota"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances, plans);
  if (limits.length === 0) {
    return null;
  }

  return {
    level: "Start",
    limits,
  };
}

function normalizeZaiStartPlanBalanceLimits(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageQuotaLimit[] {
  if (!Array.isArray(balances)) {
    return [];
  }

  return balances
    .map((balance) => {
      const total = parseNumber(balance.total_units);
      const used = parseNumber(balance.used_units);
      // Start Plan balance cards must display remaining_units from the backend.
      // available_units subtracts reserved_units for in-flight requests and cannot be used as a fallback for “remaining.”
      const remaining = parseNumber(balance.remaining_units);
      if (total === null && used === null && remaining === null) {
        return null;
      }
      // balance.expires_at is the actual reset boundary for the quota bucket; the server contract guarantees this field on every bucket.
      const nextResetSeconds = parseUnixSeconds(balance.expires_at);
      const capabilityLabels = normalizeZaiStartPlanCapabilities(balance.capabilities);
      const capabilityType = readNonEmptyString(capabilityLabels.join(", "));
      const displayName = readNonEmptyString(balance.show_name);
      const planId = readNonEmptyString(balance.plan_id);
      const userPlanId = readNonEmptyString(balance.user_plan_id);
      const plan = plans?.find((candidate) =>
        userPlanId && candidate.user_plan_id
          ? candidate.user_plan_id === userPlanId
          : candidate.plan_id === planId,
      );
      const period = plan?.entitlements?.find(
        (entry) => entry.entitlement_id === balance.entitlement_id,
      )?.period;
      const periodStart = parseUnixSeconds(balance.period_start);
      const periodEnd = parseUnixSeconds(balance.period_end);

      return {
        // The old mapping dropped bucket and period fields, leaving Renderer to deduplicate by changing balances and causing repeated reminders.
        bucketId: readNonEmptyString(balance.bucket_id) ?? undefined,
        userPlanId: userPlanId ?? undefined,
        periodStart: periodStart === null ? undefined : periodStart * 1000,
        periodEnd: periodEnd === null ? undefined : periodEnd * 1000,
        period: readNonEmptyString(period) ?? undefined,
        meter: readNonEmptyString(balance.meter) ?? undefined,
        unitType: readNonEmptyString(balance.unit_type) ?? undefined,
        type:
          readNonEmptyString(balance.entitlement_id) ??
          capabilityType ??
          readNonEmptyString(balance.meter) ??
          "model_usage",
        // planId lets the settings page group quota buckets by plan card; the server contract guarantees plan_id on every bucket.
        ...(planId ? { planId } : {}),
        unit: total ?? undefined,
        number: total ?? undefined,
        usage: used ?? undefined,
        currentValue: used ?? undefined,
        remaining: remaining ?? undefined,
        percentage:
          total !== null && remaining !== null && total > 0 ? remaining / total : undefined,
        nextResetTime: nextResetSeconds === null ? undefined : nextResetSeconds * 1000,
        usageDetails: capabilityLabels.map((modelCode) => ({
          modelCode,
          // The Today's balance endpoints for both Start Plans already return a user-facing show_name.
          // Deriving it from capabilities would display GLM-5-Turbo as GLM-5Turbo and lose the server-provided naming semantics.
          ...(displayName ? { displayName } : {}),
          usage: used ?? 0,
        })),
      };
    })
    .filter((limit): limit is NonNullable<typeof limit> => limit !== null);
}

function normalizeZaiStartPlanCapabilities(capabilities: string[] | undefined): string[] {
  if (!Array.isArray(capabilities)) {
    return [];
  }

  return capabilities
    .map((capability) =>
      capability.startsWith("model:") ? capability.slice("model:".length) : capability,
    )
    .filter((capability) => capability.trim().length > 0);
}

function parseNumber(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numericValue) ? numericValue : null;
}

function pickCurrentZaiStartPlan(plans: ZaiStartPlanPlan[] | undefined): ZaiStartPlanPlan | null {
  return (
    plans?.find((plan) => {
      const status = readNonEmptyString(plan.status)?.toLowerCase();
      const planId = readNonEmptyString(plan.plan_id)?.toLowerCase();
      const name = readNonEmptyString(plan.name)?.toLowerCase();
      return (
        status === "active" && (isZaiStartPlanIdentity(planId) || isZaiStartPlanIdentity(name))
      );
    }) ?? null
  );
}

function readZaiStartPlanBalances(
  payload: ZaiStartPlanBalanceEnvelope,
): ZaiStartPlanBalance[] | undefined {
  return payload.data?.balances as ZaiStartPlanBalance[] | undefined;
}

function summarizeStartPlans(plans: ZaiStartPlanPlan[] | undefined): Array<{
  name: string | null;
  plan_id: string | null;
  status: string | null;
}> {
  return (plans ?? []).map((plan) => ({
    name: plan.name ?? null,
    plan_id: plan.plan_id ?? null,
    status: plan.status ?? null,
  }));
}

function summarizeStartPlanBalances(balances: ZaiStartPlanBalance[] | undefined): Array<{
  entitlement_id: string | null;
  show_name: string | null;
  total_units: number | string | null;
  used_units: number | string | null;
  remaining_units: number | string | null;
  available_units: number | string | null;
  reserved_units: number | string | null;
}> {
  return (balances ?? []).map((balance) => ({
    entitlement_id: balance.entitlement_id ?? null,
    show_name: balance.show_name ?? null,
    total_units: balance.total_units ?? null,
    used_units: balance.used_units ?? null,
    remaining_units: balance.remaining_units ?? null,
    available_units: balance.available_units ?? null,
    reserved_units: balance.reserved_units ?? null,
  }));
}

function isZaiStartPlanIdentity(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.includes("start-plan") || value.includes("start plan");
}

function pickZaiStartPlanBillingCycle(plan: ZaiStartPlanPlan): string | null {
  return (
    plan.entitlements
      ?.map((item) => readNonEmptyString(item.period))
      .find((period): period is string => Boolean(period)) ?? null
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatUnixSecondsAsIso(value: number | string | null | undefined): string | null {
  const numericValue = parseUnixSeconds(value);
  if (numericValue === null) {
    return null;
  }

  return new Date(numericValue * 1000).toISOString();
}

function parseUnixSeconds(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue;
}

function buildUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "model-usage" | "tool-usage",
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/quota\/limit$/, `/${endpoint}`);
  if (resolved.teamContext) {
    // BigModel Team Plan monitor usage endpoints, like quota/limit, route by type=2.
    // Supplying only the team-project key/header still selects the personal Coding Plan branch and returns that no plan exists.
    url.searchParams.set("type", "2");
  }
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

function buildCreditUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "activity" | "usage-detail",
  startTime: string,
  endTime: string,
  usageType?: "MODEL" | "MCP",
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/usage\/quota\/limit$/, `/credit-usage/${endpoint}`);
  // Team Plan quota/limit still uses type=2, but credit-usage uses type=3.
  // Reusing type=2 triggers the backend branch that allows only enterprise owners to query organization-wide totals.
  url.searchParams.set("type", resolved.teamContext ? "3" : "1");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  if (usageType) {
    url.searchParams.set("usageType", usageType);
  }
  return url.toString();
}

function buildModelPerformanceMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/quota\/limit$/, "/model-performance-day");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

function resolveCreditUsageActivityTimeRange(timeZone: string | undefined): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
  const startDateKey = addDaysToDateKey(endDateKey, -365);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

function resolveModelPerformanceTimeRange(
  timeZone: string | undefined,
  range: "7d" | "30d",
): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
  const startDateKey = addDaysToDateKey(endDateKey, range === "7d" ? -6 : -29);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

function formatDateInTimeZone(date: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function resolveQuotaUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return readEnv(env, "ZCODE_BIGMODEL_USAGE_QUOTA_URL") ?? readEnv(env, "BIGMODEL_USAGE_QUOTA_URL");
}

function resolveCodingPlanApiKeyError(providerId: string | undefined): string {
  if (providerId && isZaiCodingPlanProviderId(providerId)) {
    return "zai_coding_plan_api_key_required";
  }
  return "bigmodel_coding_plan_api_key_required";
}

function resolveAccountProviderQuotaUrl(providerId: string, env: NodeJS.ProcessEnv): string {
  return isZaiCodingPlanProviderId(providerId) ? buildZaiQuotaUrl(env) : buildBigModelQuotaUrl(env);
}

function resolveAccountProviderLabel(providerId: string): string {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    ? "Z.ai - Coding Plan"
    : "BigModel - Coding Plan";
}

function buildBigModelQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  return buildBigModelApiUrl(env, BIGMODEL_QUOTA_PATH);
}

function buildZaiQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  // ZAI usage/quota shares the business domain with business login.
  // Test environments must use the configured ZAI Business origin and must not send test tokens to production api.z.ai.
  return buildRuntimeZaiBusinessUrl(env, "/api/monitor/usage/quota/limit");
}
