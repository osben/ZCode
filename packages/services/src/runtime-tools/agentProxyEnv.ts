import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_WORKSPACE_IDENTITY_ENV,
} from "@zcode/shared";

// Convert the settings page's HTTP proxy, No Proxy, and custom CA values into environment patches for the agent subprocess.
// The agent inherits the host's process.env; inject the proxy and certificate at spawn time, so changes take effect the next time the agent starts.
//
// Proxy: set the three standard uppercase variables so the settings page takes precedence over inherited shell variables of the same name (the model registry checks HTTPS_PROXY →
// HTTP_PROXY → …, preferring uppercase); also set ZCODE_HTTP_PROXY so Bash tool subprocesses receive the highest-priority value through subprocess-env.
//
// No Proxy: accept only bypass rules explicitly entered in the settings page. Also set ZCODE_NO_PROXY so provider/http adapters
// can reuse the same rules without reading the user's shell NO_PROXY.
//
// Custom certificate: accept only a PEM path explicitly entered in the settings page. Inject NODE_EXTRA_CA_CERTS so the agent (including model provider requests)
// trusts it at Node startup, and set ZCODE_AGENT_CA_CERT for adapters and tool subprocesses that use other runtimes.

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  ZCODE_HTTP_PROXY_ENV_KEY,
] as const;
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy", ZCODE_NO_PROXY_ENV_KEY] as const;

function buildAgentProxyEnv(httpProxy: string | undefined): Record<string, string> {
  const normalized = normalizeProxyValue(httpProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

function buildAgentCaCertEnv(caCertPath: string | undefined): Record<string, string> {
  const trimmed = caCertPath?.trim();
  if (!trimmed) {
    return {};
  }
  return {
    // NODE_EXTRA_CA_CERTS must exist before the Node process starts; ZCODE_AGENT_CA_CERT is used by runtime config,
    // provider fetch, and tool subprocesses so sanitizing standard CA variables does not lose the certificate path explicitly injected by the app.
    NODE_EXTRA_CA_CERTS: trimmed,
    [ZCODE_AGENT_CA_CERT_ENV_KEY]: trimmed,
  };
}

function buildAgentNoProxyEnv(noProxy: string | undefined): Record<string, string> {
  const normalized = normalizeNoProxyValue(noProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of NO_PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

/**
 * Runtime env patch resolved once when spawning the agent: proxy + No Proxy + custom CA.
 * These values come only from explicit AppSettings config; standard proxy/certificate variables from the user's shell were already sanitized upstream.
 */
export function buildAgentRuntimeEnv(input: {
  httpProxy: string | undefined;
  noProxy?: string | undefined;
  caCertPath?: string | undefined;
}): Record<string, string> {
  const proxyEnv = buildAgentProxyEnv(input.httpProxy);
  return {
    ...proxyEnv,
    ...buildAgentNoProxyEnv(input.noProxy),
    ...buildAgentCaCertEnv(input.caCertPath),
  };
}

/**
 * Pass the host-resolved **authoritative ZCode API origin** to the agent subprocess.
 *
 * Both sides use the same `@zcode/shared` implementation for official MCP trust checks, but their **inputs**
 * used to diverge: the host called `resolveRuntimeZCodeEndpointOrigin(env, { overrideOrigin: settings
 * .zcodeEndpointOrigin })`, while the agent called only `resolveRuntimeZCodeEndpointOrigin(env)`, and the settings
 * override was never passed to the subprocess. With `ZCODE_ENV=test` and a custom endpoint configured in settings, both sides computed
 * different origins, so official MCPs on either origin were fail-closed by one side, with logs resembling a misconfigured plugin URL.
 * A shared implementation cannot fix divergent inputs, so the input must be unified too.
 *
 * Why inject `ZCODE_BASE_URL` instead of adding an argument only to trust checks: the agent calls
 * `resolveRuntimeZCodeEndpointOrigin` in four places (trust checks, provider routing source headers, model-config,
 * auth-login), and all read the same env. One injection aligns them all; fixing trust checks alone would leave the other three diverging.
 *
 * Idempotency: the input is the host's **already resolved** final value. The agent inherits the host's process.env, so its env-derived
 * result already matches the host's; applying this override yields the same value. In production the host ignores
 * the override, so the injected value equals the env-derived value and behavior is unchanged.
 *
 * Freshness: same semantics as proxy/CA — read at spawn time, effective on the next agent start. If settings change during a session, the host updates immediately
 * while the agent keeps the old value until restart; any mismatch during that interval only fails closed and cannot grant access.
 */
export function buildAgentEndpointOriginEnv(
  endpointOrigin: string | undefined,
): Record<string, string> {
  const trimmed = endpointOrigin?.trim();
  if (!trimmed) {
    return {};
  }
  // ZCODE_BASE_URL is the highest-priority envBaseOrigin key read by resolveRuntimeZCodeEndpointOrigin,
  // so it overrides an inherited ZCODE_ENDPOINT_ORIGIN.
  return { ZCODE_BASE_URL: trimmed };
}

/** Inject the Host-known remote workspace identity into the corresponding Agent; local workspaces keep the path fallback. */
export function buildAgentWorkspaceIdentityEnv(
  workspaceIdentity: string | undefined,
): Record<string, string> {
  const trimmed = workspaceIdentity?.trim();
  return trimmed ? { [ZCODE_WORKSPACE_IDENTITY_ENV]: trimmed } : {};
}

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // Preserve values that already include a scheme (http://, socks5://, etc.); add http:// to a bare host:port.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeNoProxyValue(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}
