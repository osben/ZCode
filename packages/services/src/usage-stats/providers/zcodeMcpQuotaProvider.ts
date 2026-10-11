/* Reads the ZCode official Server MCP usage quota (`GET /api/v1/mcp/usage`).
 *
 * This file owns all details of the endpoint: path, envelope parsing, and total quota mapping. **Authentication is not implemented here**—
 * the identity headers must use the same five headers as the Server MCP endpoint, produced only by
 * `official-mcp/officialMcpCredentials.ts`'s buildOfficialMcpAuthHeaders.
 * This accepts only an injected credential resolver; never assemble, add, or change header prefixes here, or quota reads will diverge from the server's
 * WithCodingPlan behavior.
 */
import { z } from "zod";
import {
  MCP_USAGE_QUOTA_LIMIT_TYPE,
  buildRuntimeZCodeApiUrl,
  type ApiClient,
  type UsageMcpQuotaScope,
  type UsageMcpQuotaSnapshot,
  type UsageQuotaLimit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  buildOfficialMcpAuthHeaders,
  type OfficialMcpCredentialOutcome,
} from "#src/official-mcp/officialMcpCredentials.js";

const MCP_USAGE_PATH = "/api/v1/mcp/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");

/**
 * Injected source for official MCP credentials.
 *
 * Inject **credential resolution**, not createOfficialMcpAuthHeadersResolver's resolveHeaders:
 * ownership validation requires snapshot.providerFamily, which is not present in identity headers (they include only target-type /
 * organization / project). Identity headers are still built by the shared buildOfficialMcpAuthHeaders to keep one source of truth.
 */
export interface OfficialMcpCredentialSource {
  resolve(): Promise<OfficialMcpCredentialOutcome>;
}

const mcpUsageTotalSchema = z.object({
  used: z.number().finite(),
  limit: z.number().finite(),
  remaining: z.number().finite(),
});

const mcpUsageDataSchema = z.object({
  server_time: z.number().finite(),
  next_refresh_at: z.number().finite().optional(),
  level: z.string().optional(),
  /**
   * Total quota aggregated by the server.
   *
   * Intentionally optional rather than required: a missing field on a required property would trigger the generic "unexpected structure" warning and be mixed with "the whole response is broken".
   * A separate branch can log "response missing total_usage", making future API changes easy to identify. This line exists because of the previous incident:
   * the server changed its response from a `buckets` array to total_usage, the client schema validation failed,
   * and because mcpQuota is optional (failures silently degrade), the quota bar disappeared without explanation.
   */
  total_usage: mcpUsageTotalSchema.optional(),
});

const mcpUsageEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: mcpUsageDataSchema.optional().nullable(),
});

/** Connection ownership for this entitlement query, used to compare with credential ownership. */
export interface McpQuotaRequestScope {
  providerFamily: "zai" | "bigmodel";
  organizationId?: string | null;
  projectId?: string | null;
}

/**
 * Whether credential ownership matches this entitlement query.
 *
 * Credentials come from the connection currently selected in Settings, while entitlements are queried separately for each provider tab.
 * A user with both Z.AI and BigModel Coding Plan (or personal and Team) would see an MCP quota that does not belong to them under the other tab without this comparison.
 */
export function matchesMcpQuotaScope(
  scope: UsageMcpQuotaScope,
  request: McpQuotaRequestScope,
): boolean {
  if (scope.providerFamily !== request.providerFamily) {
    return false;
  }
  const requestOrganizationId = request.organizationId?.trim() ?? "";
  const requestProjectId = request.projectId?.trim() ?? "";
  const requestIsTeam = Boolean(requestOrganizationId && requestProjectId);
  if (!requestIsTeam) {
    return scope.targetType === "PERSONAL";
  }
  if (scope.targetType !== "TEAM") return false;
  return (
    (scope.organizationId?.trim() ?? "") === requestOrganizationId &&
    (scope.projectId?.trim() ?? "") === requestProjectId
  );
}

/**
 * Map the server's aggregate quota to an equivalent UsageQuotaLimit and reuse the existing quota bar/card display logic.
 *
 * percentage follows the quota endpoint semantics (percentage **used**); the presentation layer consistently flips it to show remaining quota.
 */
export function buildMcpQuotaAggregateLimit(params: {
  totalUsage: { used: number; limit: number; remaining: number };
  nextResetTime?: number;
}): UsageQuotaLimit | null {
  const limit = Math.max(0, params.totalUsage.limit);
  if (limit <= 0) {
    // Do not render an empty 0% bar when no quota is available.
    return null;
  }
  // The server already clamps remaining to 0; clamp the upper bound again here because invalid data (remaining > limit) would produce a negative
  // used percentage, which the presentation layer would flip to more than 100% remaining.
  const remaining = Math.min(Math.max(0, params.totalUsage.remaining), limit);
  const used = Math.max(0, params.totalUsage.used);

  const usedPercentage = Math.max(0, Math.min(100, 100 - (remaining / limit) * 100));
  return {
    type: MCP_USAGE_QUOTA_LIMIT_TYPE,
    currentValue: used,
    usage: used,
    remaining,
    percentage: usedPercentage,
    ...(params.nextResetTime === undefined ? {} : { nextResetTime: params.nextResetTime }),
    // Leave usageDetails empty: StatusCards renders this field as a model name, which does not fit a quota dimension.
    usageDetails: [],
  };
}

function readScopeFromCredentialSnapshot(
  snapshot: Extract<OfficialMcpCredentialOutcome, { ok: true }>["snapshot"],
): UsageMcpQuotaScope | null {
  const scope = snapshot.planScope;
  if (!scope) return null;
  return scope.targetType === "TEAM"
    ? {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        providerFamily: snapshot.providerFamily,
        targetType: "TEAM",
      }
    : { providerFamily: snapshot.providerFamily, targetType: "PERSONAL" };
}

function readRequestId(headers: Headers): string | null {
  return headers.get("x-request-id")?.trim() || null;
}

/** Response-body truncation limit. Normal responses are only a few hundred bytes; truncation handles error pages such as gateway HTML. */
const MAX_LOGGED_BODY_CHARS = 512;

/**
 * The response body can be logged as-is: this endpoint's data contains only server_time / next_refresh_at / level / total_usage,
 * all non-sensitive counts and **no credentials**. Conversely, omitting it directly slowed the last incident investigation:
 * the server changed a field name, and the client only reported "unexpected structure", so it was impossible to see what it had received.
 */
function truncateForLog(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_BODY_CHARS
    ? `${trimmed.slice(0, MAX_LOGGED_BODY_CHARS)}…(${trimmed.length} chars)`
    : trimmed;
}

/**
 * Read MCP quota once. This is an optional data surface: every failure returns null and logs only a warning,
 * and never affects the entitlement snapshot's success or degradation semantics.
 */
export async function fetchMcpQuotaSnapshot(params: {
  apiClient: ApiClient;
  credentialSource: OfficialMcpCredentialSource;
  env: NodeJS.ProcessEnv;
  requestScope: McpQuotaRequestScope;
}): Promise<UsageMcpQuotaSnapshot | null> {
  let outcome: OfficialMcpCredentialOutcome;
  try {
    outcome = await params.credentialSource.resolve();
  } catch (error) {
    log.warn(undefined, "读取官方 MCP 额度凭证失败，跳过该额度", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!outcome.ok) {
    // Do not send a request for official_auth_plan_required (no Coding Plan / Start Plan / API Key mode) or
    // official_auth_unavailable (not signed in, credentials missing, or a selection-state race).
    log.info(undefined, "官方 MCP 额度不可用，跳过请求", { reason: outcome.reason });
    return null;
  }

  const scope = readScopeFromCredentialSnapshot(outcome.snapshot);
  if (!scope) {
    log.info(undefined, "官方 MCP 额度缺少可精确归属的套餐 scope，跳过请求", {
      credentialFamily: outcome.snapshot.providerFamily,
    });
    return null;
  }
  if (!matchesMcpQuotaScope(scope, params.requestScope)) {
    log.info(undefined, "官方 MCP 额度归属与本次查询不一致，跳过请求", {
      credentialFamily: scope.providerFamily,
      credentialTargetType: scope.targetType ?? null,
      requestFamily: params.requestScope.providerFamily,
      requestOrganizationId: params.requestScope.organizationId ?? null,
      requestProjectId: params.requestScope.projectId ?? null,
    });
    return null;
  }

  const url = buildRuntimeZCodeApiUrl(params.env, MCP_USAGE_PATH);
  const headers = buildOfficialMcpAuthHeaders(outcome.snapshot);
  let payload: unknown;
  let requestId: string | null = null;
  let body = "";
  // Log one info entry for the request and one for the response (not debug): Info is the lowest level in production builds, so debug-only logs
  // would be invisible during an incident. This endpoint is triggered by the entitlement TTL cache and runs only a few times per session, so logs will not grow excessively.
  // Log header **names** only, never values—they contain JWTs and Coding Plan credentials.
  log.info(undefined, "官方 MCP 额度请求", {
    credentialFamily: scope.providerFamily,
    credentialTargetType: scope.targetType ?? null,
    headerNames: Object.keys(headers).sort(),
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    url,
  });
  const startedAt = Date.now();
  try {
    const response = await params.apiClient.request(url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      // Use the shared identity-header result as-is: do not modify, add, or change the prefix of any of the five headers.
      headers,
    });
    requestId = readRequestId(response.headers);
    const text = await response.text();
    body = truncateForLog(text);
    log.info(undefined, "官方 MCP 额度响应", {
      body,
      durationMs: Date.now() - startedAt,
      status: response.status,
      url,
      "x-request-id": requestId,
    });
    if (!response.ok) {
      log.warn(undefined, "官方 MCP 额度请求失败", {
        body,
        status: response.status,
        url,
        "x-request-id": requestId,
      });
      return null;
    }
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    log.warn(undefined, "官方 MCP 额度请求异常", {
      body,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      url,
      "x-request-id": requestId,
    });
    return null;
  }

  const envelope = mcpUsageEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    // Include the response body and zod issue paths; reporting only "unexpected structure" does not show which field the server changed.
    log.warn(undefined, "官方 MCP 额度响应结构不符合预期", {
      body,
      issues: envelope.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`,
      ),
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  if (envelope.data.code !== 0 || !envelope.data.data) {
    // Business failures (such as a 1000 usage-storage error) clear only this quota and are not rethrown.
    log.warn(undefined, "官方 MCP 额度业务失败", {
      code: envelope.data.code,
      msg: envelope.data.msg ?? null,
      "x-request-id": requestId,
    });
    return null;
  }

  const data = envelope.data.data;
  if (!data.total_usage) {
    // Log separately from "unexpected structure"; this specifically indicates the endpoint renamed or moved the total quota field.
    log.warn(undefined, "官方 MCP 额度响应缺少 total_usage", {
      body,
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  const aggregate = buildMcpQuotaAggregateLimit({
    totalUsage: data.total_usage,
    // The endpoint uses Unix seconds; the client's nextResetTime is in milliseconds throughout the pipeline.
    ...(data.next_refresh_at === undefined ? {} : { nextResetTime: data.next_refresh_at * 1000 }),
  });
  if (!aggregate) {
    return null;
  }

  return {
    aggregate,
    level: data.level?.trim() || null,
    scope,
    serverTime: data.server_time * 1000,
  };
}
