/* Shared constants and types for ZCode official Server MCP authentication.
   This belongs in shared because two consumers in separate packages use the header set:
   - `packages/services` produces the identity headers;
   - `apps/zcode-cli/packages/adapters` (Plugin parser + MCP adapter) intercepts and preserves them.
   Both sides must use the same source. Otherwise, a new identity header could be omitted from the
   blocklist, allowing a static header to overwrite credentials. */

/** The only valid value for `auth.type` in `.mcp.json`; case-sensitive and aliases are not accepted. */
export const ZCODE_OFFICIAL_MCP_AUTH_TYPE = "zcode_official" as const;

/** The only valid provider in phase one. Add a new provider value for future short-lived tokens; do not change this value's meaning. */
export const ZCODE_OFFICIAL_MCP_AUTH_PROVIDER_JWT_TOKEN = "jwt_token" as const;

/**
 * Official MCP uses two independent credentials: user identity and plan identity.
 * codingPlanAuthorization must carry the MaaS login JWT; it cannot be replaced with a Coding Plan business API key.
 * The server uses customer_id in the JWT to verify its association with the current user.
 */
export const OFFICIAL_MCP_AUTH_HEADER_NAMES = {
  authorization: "Authorization",
  codingPlanAuthorization: "X-Bigmodel-Authorization",
  targetType: "Bigmodel-Target-Type",
  organization: "Bigmodel-Organization",
  project: "Bigmodel-Project",
} as const;

/**
 * Key used for the identity header of stdio official MCP in `params._meta` for all outbound requests and notifications.
 *
 * This is a **cross-language protocol constant** shared with plugin processes; the Plugin side (such as a plugin's Python server)
 * reads the same string. Renaming it breaks all published plugins and is equivalent to a protocol breaking change.
 * The namespace prefix follows `com.zcode/`, consistent with the existing `com.zcode/request-context`.
 */
export const OFFICIAL_MCP_AUTH_META_KEY = "com.zcode/official-mcp-auth" as const;

/**
 * Reserved headers that are forbidden in static Plugin `headers` (lowercase; compared case-insensitively).
 *
 * Identity headers prevent static Plugin config from forging or overriding credentials.
 * Protocol headers (mcp-session-id / mcp-protocol-version) are included because the SDK gives
 * `requestInit.headers` priority over protocol headers, allowing static config to override the session ID.
 *
 * `x-coding-plan-api-key` is no longer sent by clients (they switched to the MaaS JWT channel), but **must remain
 * on the denylist**: the server channel is still active (`credential := cmp.Or(Authorization, APIKey)`),
 * and allowing it would let a Plugin impersonate an official endpoint with a Coding Plan credential in a static header.
 * It is listed explicitly rather than derived from the header-name table precisely because it is no longer in that table.
 */
export const OFFICIAL_MCP_RESERVED_HEADER_NAMES: readonly string[] = [
  ...Object.values(OFFICIAL_MCP_AUTH_HEADER_NAMES).map((name) => name.toLowerCase()),
  "x-coding-plan-api-key",
  "mcp-session-id",
  "mcp-protocol-version",
];

const RESERVED_HEADER_SET = new Set(OFFICIAL_MCP_RESERVED_HEADER_NAMES);

/** Check whether a header is reserved, case-insensitively. */
export function isOfficialMcpReservedHeaderName(name: string): boolean {
  return RESERVED_HEADER_SET.has(name.trim().toLowerCase());
}

/** Return reserved headers found in a static header record (lowercase, deduplicated, and sorted deterministically), or an empty array if none match. */
export function findOfficialMcpReservedHeaders(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) return [];
  const hits = new Set<string>();
  for (const name of Object.keys(headers)) {
    const normalized = name.trim().toLowerCase();
    if (RESERVED_HEADER_SET.has(normalized)) hits.add(normalized);
  }
  return [...hits].sort();
}

/** Values for the server's `Bigmodel-Target-Type` (aligned with zcode-server's CodingPlanTargetType). */
export type OfficialMcpTargetType = "PERSONAL" | "TEAM";

/**
 * Port/protocol-level failure categories (the two cases where "no request is sent").
 * Network failures (401/403/3xx) are classified by the MCP adapter after receiving a response and do not use this enum.
 */
export const OFFICIAL_MCP_AUTH_FAILURE_REASONS = [
  "official_auth_unavailable",
  "official_auth_plan_required",
] as const;

export type OfficialMcpAuthFailureReason = (typeof OFFICIAL_MCP_AUTH_FAILURE_REASONS)[number];

export const OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS = [
  ...OFFICIAL_MCP_AUTH_FAILURE_REASONS,
  "official_mcp_origin_untrusted",
] as const;

export type OfficialMcpAuthPortFailureReason =
  (typeof OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS)[number];

/** Complete failure categories on the MCP adapter side, including network results. Used only for status recording and logs. */
export type OfficialMcpAuthFailureKind =
  | OfficialMcpAuthFailureReason
  | "official_mcp_origin_untrusted"
  | "official_auth_rejected"
  | "official_auth_forbidden"
  | "official_auth_redirect_blocked";

// ── Official MCP trust validation ──
// Located in shared rather than CLI bootstrap because there are two consumers in packages that cannot see each other:
//   - apps/zcode-cli/packages/adapters: local validation before sending a request;
//   - packages/services (host): a second check at the identity-authority boundary (depends only on @zcode/shared
//     and cannot import CLI packages).
// A single source of truth is required: divergent checks could let one side allow a request while the other rejects it.

/**
 * Normalize an origin: it must use https, have no username/password, and the URL itself must be origin-shaped.
 * Reject URLs containing credentials because `https://user:pass@a.example` has origin `https://a.example`,
 * and comparing only origins would allow it.
 */
function normalizeHttpsOrigin(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.username !== "" || url.password !== "") return undefined;
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLoopbackOrigin(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.username !== "" || url.password !== "") return undefined;
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export const OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV = "ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS";

/** Actual workspace identity injected by Host at spawn time; used only for isolation/auditing, never for file execution. */
export const ZCODE_WORKSPACE_IDENTITY_ENV = "ZCODE_WORKSPACE_IDENTITY";

/** Safe log summary for identity headers: contains only header names, Team pairing, and TargetType; no values. */
export function summarizeOfficialMcpIdentityHeaders(
  headers: Record<string, string>,
): Record<string, unknown> {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const organization = lower.has("bigmodel-organization");
  const project = lower.has("bigmodel-project");
  return {
    identityHeaderNames: [...lower.keys()].sort(),
    identityOrganizationPresent: organization,
    identityProjectPresent: project,
    identityTeamPaired: organization === project,
    ...(lower.get("bigmodel-target-type")
      ? { identityTargetType: lower.get("bigmodel-target-type") }
      : {}),
  };
}

export interface OfficialMcpTrustResult {
  trusted: boolean;
  /** Human-readable rejection reason, for logs only and not for flow control. */
  detail: "ok" | "invalid_input" | "origin_mismatch" | "zcode_origin_unresolved";
}

export interface IsOfficialMcpOriginTrustedInput {
  /** Raw local self-test switch value (usually from env); allows only http loopback. */
  devTrustedOriginsRaw?: string | undefined;
  origin: string;
  /**
   * Declared plugin ID for this MCP. **Not used for trust decisions**; used only for log attribution and credential-resolution
   * ownership. Included in the input so logs can answer "which plugin requested the credentials?"
   */
  pluginId: string;
  /** Current ZCode API origin, resolved by the caller according to its own conventions. */
  zcodeApiOrigin: string | undefined;
}

/**
 * Validate the credential target for official MCP: require an HTTPS origin equal to the runtime ZCode API origin,
 * with no username/password in the URL. Development config allows only explicitly listed HTTP loopback origins.
 *
 * pluginId is for attribution and logs, not an authorization filter; any loaded plugin may request official authentication.
 * Destination validation does not replace per-endpoint user permission, plan, or quota checks and does not provide per-plugin authorization.
 * Plugins using stdio authentication hold credentials and must be managed as trusted executable code.
 */
export function isOfficialMcpOriginTrusted(
  input: IsOfficialMcpOriginTrustedInput,
): OfficialMcpTrustResult {
  const origin = input.origin.trim();
  if (!origin) {
    return { detail: "invalid_input", trusted: false };
  }

  // Local self-test switch: accepts only http loopback, so credentials cannot be sent to a remote host.
  // First verify that the **target origin itself is loopback**; otherwise both normalization calls return undefined,
  // and `undefined === undefined` would let this switch allow any origin (including remote https sites).
  const loopbackOrigin = normalizeLoopbackOrigin(origin);
  if (loopbackOrigin) {
    for (const candidate of parseDevTrustedOrigins(input.devTrustedOriginsRaw)) {
      if (normalizeLoopbackOrigin(candidate) === loopbackOrigin) {
        return { detail: "ok", trusted: true };
      }
    }
  }

  const expected = input.zcodeApiOrigin ? normalizeHttpsOrigin(input.zcodeApiOrigin) : undefined;
  if (!expected) return { detail: "zcode_origin_unresolved", trusted: false };
  if (normalizeHttpsOrigin(origin) !== expected) {
    return { detail: "origin_mismatch", trusted: false };
  }
  return { detail: "ok", trusted: true };
}

/**
 * Local self-test switch; value is a comma-separated list of loopback origins, for example `http://127.0.0.1:3999`.
 * Applies only to http loopback: the worst case is sending one's own JWT to a local process, where any local program could already
 * read the same credential, so this does not expand the trust surface. When unset, behavior is identical to builds without this switch.
 */
function parseDevTrustedOrigins(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Trust validator. Keep the `isTrusted` DI shape unchanged so the adapter and host can share one implementation.
 * It is asynchronous so the host can resolve origin overrides from settings (using the same rules as off-peak tasks), avoiding
 * inconsistent behavior where "off-peak tasks connect, but official MCP does not."
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: {
    mcpKey: string;
    origin: string;
    pluginId: string;
  }): Promise<OfficialMcpTrustResult>;
}

export interface CreateOfficialMcpTrustedOriginRegistryOptions {
  /** Raw local self-test switch (comma-separated loopback origins), usually from env. */
  devTrustedOriginsRaw?: string | undefined;
  /** Resolver for the current ZCode API origin; both sides must use equivalent rules or one could allow while the other rejects. */
  resolveZCodeApiOrigin: () => string | undefined | Promise<string | undefined>;
}

export function createOfficialMcpTrustedOriginRegistry(
  options: CreateOfficialMcpTrustedOriginRegistryOptions,
): OfficialMcpTrustedOriginRegistry {
  return {
    async isTrusted({ origin, pluginId }) {
      let zcodeApiOrigin: string | undefined;
      try {
        zcodeApiOrigin = await options.resolveZCodeApiOrigin();
      } catch {
        // Treat resolution errors as untrusted; never allow a request because the origin could not be resolved.
        return { detail: "zcode_origin_unresolved", trusted: false };
      }
      return isOfficialMcpOriginTrusted({
        devTrustedOriginsRaw: options.devTrustedOriginsRaw,
        origin,
        pluginId,
        zcodeApiOrigin,
      });
    },
  };
}
