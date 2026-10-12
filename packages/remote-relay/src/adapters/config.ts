import type { RelayServerOptions } from "../contract.js";

export function readRelayConfig(env: Record<string, string | undefined>) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing relay configuration: ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid relay configuration: ${name}`);
    return value;
  };
  const list = (name: string) => (env[name] ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const host = env.ZCODE_RELAY_HOST?.trim() || "127.0.0.1";
  const port = integer("ZCODE_RELAY_PORT", 3031);
  if (port > 65535) throw new Error("Invalid relay port.");
  const origins = list("ZCODE_RELAY_ALLOWED_ORIGINS");
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error("Invalid relay Web origin.");
  }
  if (host !== "127.0.0.1" && host !== "::1" && origins.length === 0) throw new Error("Public relay requires explicit Web origins.");
  const server: Omit<RelayServerOptions, "store"> = {
    host, port,
    allowedOrigins: origins,
    trustedProxies: list("ZCODE_RELAY_TRUSTED_PROXIES"),
    maxConnections: integer("ZCODE_RELAY_MAX_CONNECTIONS", 2000),
    registrationsPerMinute: integer("ZCODE_RELAY_REGISTRATIONS_PER_MINUTE", 20),
    maxBufferedBytes: integer("ZCODE_RELAY_MAX_BUFFERED_BYTES", 2 * 1024 * 1024),
    maxTotalBufferedBytes: integer("ZCODE_RELAY_MAX_TOTAL_BUFFERED_BYTES", 64 * 1024 * 1024),
  };
  return {
    server,
    store: {
      path: required("ZCODE_RELAY_DB_PATH"),
      storageKey: required("ZCODE_RELAY_STORAGE_KEY"),
      maxRecords: integer("ZCODE_RELAY_MAX_REGISTRATIONS", 100_000),
    },
  };
}
