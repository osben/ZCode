import type {
  ApiClient,
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanRegularTpsRequest,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
import { isCodingPlanModelProviderId } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";
import {
  BigModelUsageQuotaProvider,
  type UsageApiAuthorizationRequest,
  type UsageApiAuthorization,
} from "./providers/bigmodelUsageQuotaProvider.js";
import type { OfficialMcpCredentialSource } from "./providers/zcodeMcpQuotaProvider.js";

interface UsageStatsServiceDependencies {
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
  /** Read actual usage statistics from the agent database through the ZCode Protocol. */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /**
   * Credential source for official Server MCP quota (the same five identity headers used by Server MCP calls).
   * When omitted, the entitlement snapshot does not include MCP quota.
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

const CODING_PLAN_REGULAR_TPS_CACHE_MS = 5 * 60_000;

function isCodingPlanProviderId(providerId: string | undefined): boolean {
  return Boolean(providerId && isCodingPlanModelProviderId(providerId));
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  const quotaProvider = new BigModelUsageQuotaProvider({
    apiClient: dependencies.apiClient,
    accountRequestAuthService: dependencies.accountRequestAuthService,
    resolveApiAuthorization: dependencies.resolveApiAuthorization,
    credentialService: dependencies.credentialService,
    env: dependencies.env,
    ...(dependencies.officialMcpCredentialSource
      ? { officialMcpCredentialSource: dependencies.officialMcpCredentialSource }
      : {}),
  });
  const regularTpsCache = new Map<string, { expiresAt: number; value: number | undefined }>();
  const regularTpsInFlight = new Map<string, Promise<number | undefined>>();

  function regularTpsCacheKey(request: CodingPlanRegularTpsRequest): string {
    return JSON.stringify([
      request.preferredProviderId,
      // Team scope (organizationId/projectId) is already inside accountAccess; include it wholesale in the key
      // so different accounts or team projects under the same provider do not share one TPS cache entry.
      request.accountAccess,
      request.timeZone ?? null,
    ]);
  }

  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage now reads actual statistics from the agent database (model_usage/turn_usage/tool_usage)
      // through ZCode Protocol usage/stats. It no longer estimates from local session JSON.
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
        window: request.window,
        compare: request.compare,
        filters: request.filters,
        include: request.include,
      });
    },
    async getCodingPlanUsageSnapshot(
      request: CodingPlanUsageRequest,
    ): Promise<CodingPlanUsageSnapshot> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        // The Coding Plan page supports only preconfigured Z.AI/BigModel Coding Plan accounts.
        // Ordinary provider IDs must not enter the monitor path, to avoid reading an API key or environment variable by mistake.
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.getCodingPlanUsageSnapshot(request);
    },
    async getCodingPlanRegularTps(
      request: CodingPlanRegularTpsRequest,
    ): Promise<number | undefined> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      const key = regularTpsCacheKey(request);
      const cached = regularTpsCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const existing = regularTpsInFlight.get(key);
      if (existing) return existing;

      const requestPromise = quotaProvider
        .getCodingPlanRegularTps(request)
        .then((value) => {
          regularTpsCache.set(key, {
            expiresAt: Date.now() + CODING_PLAN_REGULAR_TPS_CACHE_MS,
            value,
          });
          return value;
        })
        .finally(() => {
          regularTpsInFlight.delete(key);
        });
      regularTpsInFlight.set(key, requestPromise);
      return requestPromise;
    },
    async getCodingPlanResetStatus(
      request: CodingPlanResetScopeRequest,
    ): Promise<CodingPlanResetStatusSnapshot> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.getCodingPlanResetStatus(request);
    },
    async requestCodingPlanResetOpportunity(
      request: CodingPlanResetOpportunityRequest,
    ): Promise<CodingPlanResetOpportunityResult> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.requestCodingPlanResetOpportunity(request);
    },
    async useCodingPlanReset(
      request: CodingPlanResetUseRequest,
    ): Promise<CodingPlanResetUseResult> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.useCodingPlanReset(request);
    },
    async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      await quotaProvider.markCodingPlanResetHistoryRead(request);
    },
    async getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
      // App Usage has moved to getAppUsageSnapshot (agent database). getSnapshot serves only the Coding Plan monitor path.
      // A monitor failure must not fall back to local data, preserving source isolation.
      return quotaProvider.getUsageStatsSnapshot(request);
    },
    async getEntitlementSnapshot(
      request: UsageEntitlementRequest = {},
    ): Promise<UsageEntitlementSnapshot> {
      return quotaProvider.getSnapshotForRequest(request);
    },
  };
}
