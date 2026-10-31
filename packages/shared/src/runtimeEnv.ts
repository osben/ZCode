export const ZCODE_RUNTIME_ENV_KEY = "ZCODE_RUNTIME_ENV";
export const ZCODE_HTTP_PROXY_ENV_KEY = "ZCODE_HTTP_PROXY";
export const ZCODE_NO_PROXY_ENV_KEY = "ZCODE_NO_PROXY";
/** Network configuration passed once by the Desktop Host to a desktop-attached remote server. */
export const ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY =
  "ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY";
export const ZCODE_REMOTE_HTTP_PROXY_ENV_KEY = "ZCODE_REMOTE_HTTP_PROXY";
export const ZCODE_REMOTE_NO_PROXY_ENV_KEY = "ZCODE_REMOTE_NO_PROXY";
export const ZCODE_AGENT_CA_CERT_ENV_KEY = "ZCODE_AGENT_CA_CERT";
export const ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY = "ZCODE_TOOL_ENV_PASSTHROUGH_JSON";
/** Desktop Main passes the server-decided single-feature rollout result to the Local/Remote Host. */
export const ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV = "ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED";
export const ZCODE_CUA_PRODUCT_HELPER_ENV_KEY = "ZCODE_CUA_PRODUCT_HELPER";
export const ZCODE_CUA_BROKER_SOCKET_ENV_KEY = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
// Official command endpoint (agent-side proxy, design doc 5.8): the address and session token
// are injected per session by the agent into Bash/tool subprocesses only, never inherited via
// the agent's global env.
export const ZCODE_OFFICIAL_ENDPOINT_ENV_KEY = "ZCODE_OFFICIAL_ENDPOINT";
export const ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY = "ZCODE_OFFICIAL_ENDPOINT_TOKEN";
/** Shared node_repl host marker; unlike the broker bearer values it is not a secret. */
export const ZCODE_CUA_NODE_REPL_HOST_ENV_KEY = "ZCODE_CUA_NODE_REPL_HOST";
// One-knob local-development bundle. Setting ZCODE_CUA_DEV_MODE implies the internal feature
// flag (below) plus the local-helper relaxations wired in packages/services (unsigned/
// unauthenticated local helper, dev install variant, "Dev.app" naming). It exists so a developer
// can launch the full local CUA loop with a single env var instead of the historical four-var
// incantation. These switches apply only to unpackaged local builds; official desktop/Helper bundles
// disable them at compile time and remove them at the main→host boundary, so they cannot override a signed release at runtime.
export const ZCODE_CUA_DEV_MODE_ENV_KEY = "ZCODE_CUA_DEV_MODE";

export type ZCodeRuntimeEnv = "development" | "production" | "test";

type EnvRecord = Record<string, string | undefined>;

export function isCuaDevModeRequested(env: EnvRecord = process.env): boolean {
  const explicit = env[ZCODE_CUA_DEV_MODE_ENV_KEY]?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "on";
}

export function isZCodeCuaInternalFeatureEnabled(env: EnvRecord = process.env): boolean {
  // CUA is now included in official builds by default (plugin staged + Helper enabled), so no explicit env flag is needed.
  // DEV_MODE still implies it (one-switch development setup); PRODUCT_HELPER=0/off/false explicitly disables it.
  if (isCuaDevModeRequested(env)) return true;
  const explicit = env[ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  return true;
}

const SANITIZED_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  // The CUA broker socket is connection material for the target zcode-cua MCP server only (desktop/CLI
  // injects it into that server's env when resolving it). Never leak it through the agent's global env
  // to other MCP servers / Bash / tool subprocesses; a malicious MCP or prompt-injection-triggered command
  // in the same agent could otherwise drive the authorized Helper (confused deputy). Strip it from all
  // subprocess envs here; the targeted zcode-cua env is spread after buildMcpStdioEnv and remains available
  // to that server (see adapters/mcp StdioClientTransport).
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  // Legacy bearer token: the current broker uses identity mode (socket + authority, no password; see
  // captureZCodeCuaBrokerCredentials), and this process no longer creates or consumes the token. Keep
  // stripping it because users may have an older Helper installed that accepts bearer tokens. If this
  // variable leaks through the agent's global env to another MCP server / Bash subprocess, the same
  // confused-deputy risk applies. Stripping an unused key has no cost.
  "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  // The official command endpoint's address and token belong to one session and are injected
  // directionally by the agent; values inherited from the parent process (e.g. a nested agent)
  // are always stripped so one session can never hold another session's token.
  ZCODE_OFFICIAL_ENDPOINT_ENV_KEY,
  ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY,
  // Agent OTLP endpoint/auth/identity belong only to CLI telemetry bootstrap and must not leak to
  // Bash, MCP, or model-tool subprocesses. Capture them in a process-private Map before sanitizing,
  // so the Agent startup boundary can read them.
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "ZCODE_MODEL_TELEMETRY_ENABLED",
  "ZCODE_TELEMETRY_DEVICE_MID",
  // Legacy identity variables are no longer supported, but must still be stripped from all subprocess
  // environments to prevent old configuration from leaking raw account IDs or spoofable hashes to Host, Bash, and MCP.
  "ZCODE_TELEMETRY_USER_ID",
  "ZCODE_TELEMETRY_USER_ID_HASH",
  "ZCODE_TELEMETRY_USER_SUBJECT_ID",
  "ZCODE_TELEMETRY_IDENTITY_STATE",
  "ZCODE_TELEMETRY_RUNTIME_SURFACE",
  "ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION",
] as const;

const NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  // Do not restore CUA broker credentials to Bash/tool subprocesses through tool-env-passthrough; that would bypass the stripping above.
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  ZCODE_OFFICIAL_ENDPOINT_ENV_KEY,
  ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
] as const;

const SANITIZED_PACKAGE_MANAGER_ENV_PATTERN =
  /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i;

export function normalizeZCodeRuntimeEnv(value: string | undefined): ZCodeRuntimeEnv | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "development" || normalized === "production" || normalized === "test") {
    return normalized;
  }
  return undefined;
}

export function resolveZCodeRuntimeEnv(
  env: Record<string, string | undefined>,
  fallback: ZCodeRuntimeEnv = "production",
): ZCodeRuntimeEnv {
  return normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]) ?? fallback;
}

// Exported so services/node.ts can inject the Helper's plugin authority into the agent spawn env
// (mirrors feat; the agent-side plugin host verifies the broker authority via this env var).
export const ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY = "ZCODE_CUA_PLUGIN_AUTHORITY";

interface CapturedCuaBrokerCredentials {
  socket: string;
  pluginAuthority: string;
  refreshMarker?: string;
}

let capturedCuaBrokerCredentials: Readonly<CapturedCuaBrokerCredentials> | undefined;
const capturedZCodeAgentTelemetryEnv: Record<string, string> = {};

// The sanitize step above strips the CUA broker socket from subprocess envs to prevent a confused deputy:
// other MCP servers / Bash / tool subprocesses must not drive the authorized Helper directly. However,
// the CLI entry point sanitizes process.env before bootstrap reads the `zcode-cua` server from global
// ~/.zcode/cli/config.json. Targeted injection would then lose the credentials, causing the global
// zcode-cua server to fall back to `--backend auto` and make Python/uvx the TCC owner (fail-open, contrary
// to "Python/uvx must never become the implicit permission owner"). Capture the credentials in private
// process storage before stripping them, and expose them to bootstrap's targeted injection path only
// through getCapturedZCodeCuaBrokerCredentials(); never write them back to any subprocess env.
function captureZCodeCuaBrokerCredentials(env: Record<string, string | undefined>): void {
  const socket = env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim();
  const pluginAuthority = env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim();
  const refreshMarker = env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"]?.trim();
  // The connection has no password: socket + authority (a config-provenance nonce) form a valid credential
  // set only when both are present; a partial set means upstream injection is incomplete or rotating.
  if (socket && pluginAuthority) {
    capturedCuaBrokerCredentials = Object.freeze({
      socket,
      pluginAuthority,
      ...(refreshMarker ? { refreshMarker } : {}),
    });
    return;
  }
  if (socket || pluginAuthority) {
    // A partial credential set means upstream injection is incomplete or rotating; clear the old snapshot
    // and fail closed rather than reusing the other half.
    capturedCuaBrokerCredentials = undefined;
  }
}

function captureZCodeAgentTelemetryEnv(env: Record<string, string | undefined>): void {
  Object.assign(capturedZCodeAgentTelemetryEnv, readZCodeAgentTelemetryEnv(env));
}

/**
 * Extract only the configuration used by Agent telemetry bootstrap. After general env sanitization,
 * the host may pass these values specifically to the host/Agent; do not include them in the Bash/MCP tool env.
 */
export function readZCodeAgentTelemetryEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const telemetryEnv: Record<string, string> = {};
  for (const key of SANITIZED_RUNTIME_ENV_KEYS) {
    if (!isZCodeAgentTelemetryEnvKey(key)) continue;
    const value = env[key]?.trim();
    if (value) telemetryEnv[key] = value;
  }
  return telemetryEnv;
}

export function getCapturedZCodeAgentTelemetryEnv(): Record<string, string> {
  return { ...capturedZCodeAgentTelemetryEnv };
}

export function getCapturedZCodeCuaBrokerCredentials(): {
  socket: string | undefined;
  pluginAuthority: string | undefined;
  refreshMarker?: string;
} {
  return capturedCuaBrokerCredentials
    ? { ...capturedCuaBrokerCredentials }
    : { socket: undefined, pluginAuthority: undefined };
}

// For resetting process-captured state in tests only.
export function resetCapturedZCodeCuaBrokerCredentialsForTest(): void {
  capturedCuaBrokerCredentials = undefined;
}

export function resetCapturedZCodeAgentTelemetryEnvForTest(): void {
  for (const key of Object.keys(capturedZCodeAgentTelemetryEnv)) {
    delete capturedZCodeAgentTelemetryEnv[key];
  }
}

export function sanitizeZCodeRuntimeEnv<T extends Record<string, string | undefined>>(
  env: T,
): Record<string, string> {
  captureZCodeCuaBrokerCredentials(env);
  captureZCodeAgentTelemetryEnv(env);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || shouldSanitizeZCodeRuntimeEnvKey(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const captured = readZCodeToolEnvPassthroughEnv(env);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !shouldCaptureZCodeToolEnvPassthroughKey(key)) {
      continue;
    }
    captured[key] = value;
  }

  return stringifyZCodeToolEnvPassthroughEnv(captured);
}

export function readZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const raw = env[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY];
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const captured: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        shouldCaptureZCodeToolEnvPassthroughKey(key)
      ) {
        captured[key] = value;
      }
    }
    return captured;
  } catch {
    return {};
  }
}

export function sanitizeZCodeRuntimeEnvInPlace(env: Record<string, string | undefined>): void {
  captureZCodeCuaBrokerCredentials(env);
  captureZCodeAgentTelemetryEnv(env);
  for (const key of Object.keys(env)) {
    if (shouldSanitizeZCodeRuntimeEnvKey(key)) {
      delete env[key];
    }
  }
}

function isZCodeAgentTelemetryEnvKey(key: string): boolean {
  return (
    key.startsWith("OTEL_") ||
    key.startsWith("ZCODE_TELEMETRY_") ||
    key === "ZCODE_MODEL_TELEMETRY_ENABLED"
  );
}

export function shouldSanitizeZCodeRuntimeEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    SANITIZED_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey) ||
    SANITIZED_PACKAGE_MANAGER_ENV_PATTERN.test(key)
  );
}

export function shouldCaptureZCodeToolEnvPassthroughKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  if (isZCodeAgentTelemetryEnvKey(upperKey)) {
    return false;
  }
  if (NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey)) {
    return false;
  }
  return shouldSanitizeZCodeRuntimeEnvKey(key);
}

function stringifyZCodeToolEnvPassthroughEnv(
  captured: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(captured).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return {};
  }
  return {
    [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify(Object.fromEntries(entries)),
  };
}
