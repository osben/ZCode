import type { RelayServerOptions } from "../contract.js";

type Jwk = Record<string, unknown>;

export interface RelayRuntimeConfig {
  server: Omit<RelayServerOptions, "store" | "session">;
  store: {
    path: string;
    maxRecords: number;
    maxEnrolledKeys: number;
    keyIdleExpiryDays: number;
  };
  session: {
    signingKeys: Jwk[];
    ttlSeconds: number;
    identity:
      | {
          mode: "zai-jwt";
          issuer: string;
          audience?: string;
          userClaim: string;
          keys: Jwk[];
        }
      | {
          mode: "device-key";
          /** Absent only in open enrollment mode. */
          enrollmentSecret?: string;
          enrollment: {
            mode: "secret" | "open";
            difficulty: number;
            maxEnrolledKeys: number;
            enrollmentsPerHour: number;
          };
        };
  };
  /** Startup warnings. They name variables only, never values. */
  warnings: string[];
}

const MIN_ENROLLMENT_SECRET_LENGTH = 32;
const ZAI_IDENTITY_VARIABLES = [
  "ZCODE_REMOTE_RELAY_IDENTITY_ISSUER",
  "ZCODE_REMOTE_RELAY_IDENTITY_JWKS",
  "ZCODE_REMOTE_RELAY_IDENTITY_AUDIENCE",
  "ZCODE_REMOTE_RELAY_IDENTITY_USER_CLAIM",
] as const;

/**
 * Parses a JSON array of JWK objects, or a JWK set (`{"keys": [...]}`) when `allowSet` is true.
 * Error text names the variable, never the key material.
 */
function jwkArray(name: string, raw: string, allowSet = false): Jwk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid relay configuration: ${name} must be a JSON array.`);
  }
  const value =
    allowSet && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { keys?: unknown }).keys
      : parsed;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid relay configuration: ${name} must be a non-empty JSON array.`);
  }
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid relay configuration: ${name} must contain only JWK objects.`);
    }
  }
  return value as Jwk[];
}

/**
 * Reads relay configuration. Required identity and signing keys fail startup when absent
 * (fail closed); no network endpoint or account service is consulted.
 */
export function readRelayConfig(env: Record<string, string | undefined>): RelayRuntimeConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing relay configuration: ${name}`);
    return value;
  };
  const optional = (name: string) => env[name]?.trim() || undefined;
  const integer = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Invalid relay configuration: ${name}`);
    return value;
  };
  const list = (name: string) =>
    (env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const host = env.ZCODE_RELAY_HOST?.trim() || "127.0.0.1";
  const port = integer("ZCODE_RELAY_PORT", 3031);
  if (port > 65535) throw new Error("Invalid relay port.");
  const origins = list("ZCODE_RELAY_ALLOWED_ORIGINS");
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin)
      throw new Error("Invalid relay Web origin.");
  }
  if (host !== "127.0.0.1" && host !== "::1" && origins.length === 0)
    throw new Error("Public relay requires explicit Web origins.");
  const ttlSeconds = integer("ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS", 3600);
  if (ttlSeconds > 86_400)
    throw new Error("Invalid relay configuration: ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS");
  const warnings: string[] = [];
  const modeValue = optional("ZCODE_REMOTE_RELAY_IDENTITY_MODE");
  if (modeValue !== undefined && modeValue !== "zai-jwt" && modeValue !== "device-key") {
    throw new Error(
      "Invalid relay configuration: ZCODE_REMOTE_RELAY_IDENTITY_MODE must be zai-jwt or device-key.",
    );
  }
  const mode =
    modeValue ??
    (optional("ZCODE_REMOTE_RELAY_IDENTITY_ISSUER") || optional("ZCODE_REMOTE_RELAY_IDENTITY_JWKS")
      ? "zai-jwt"
      : undefined);
  if (mode === undefined)
    throw new Error("Missing relay configuration: ZCODE_REMOTE_RELAY_IDENTITY_MODE");
  let identity: RelayRuntimeConfig["session"]["identity"];
  if (mode === "device-key") {
    // Unset keeps the secret-only behavior; open enrollment must be chosen explicitly (fail closed).
    const enrollmentModeValue = optional("ZCODE_REMOTE_RELAY_ENROLLMENT_MODE");
    if (
      enrollmentModeValue !== undefined &&
      enrollmentModeValue !== "secret" &&
      enrollmentModeValue !== "open"
    ) {
      throw new Error(
        "Invalid relay configuration: ZCODE_REMOTE_RELAY_ENROLLMENT_MODE must be secret or open.",
      );
    }
    const enrollmentMode = enrollmentModeValue ?? "secret";
    const enrollmentSecret =
      enrollmentMode === "open"
        ? optional("ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET")
        : required("ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET");
    if (enrollmentSecret !== undefined && enrollmentSecret.length < MIN_ENROLLMENT_SECRET_LENGTH) {
      throw new Error(
        `Invalid relay configuration: ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET must be at least ${MIN_ENROLLMENT_SECRET_LENGTH} characters.`,
      );
    }
    for (const name of ZAI_IDENTITY_VARIABLES) {
      if (optional(name) !== undefined)
        warnings.push(`${name} is ignored in device-key identity mode.`);
    }
    const difficulty = integer("ZCODE_RELAY_ENROLLMENT_DIFFICULTY", 22);
    if (difficulty < 8 || difficulty > 32)
      throw new Error("Invalid relay configuration: ZCODE_RELAY_ENROLLMENT_DIFFICULTY");
    identity = {
      mode: "device-key",
      ...(enrollmentSecret === undefined ? {} : { enrollmentSecret }),
      enrollment: {
        mode: enrollmentMode,
        difficulty,
        maxEnrolledKeys: integer("ZCODE_RELAY_MAX_ENROLLED_KEYS", 10_000),
        enrollmentsPerHour: integer("ZCODE_RELAY_ENROLLMENTS_PER_HOUR", 300),
      },
    };
  } else {
    const audience = optional("ZCODE_REMOTE_RELAY_IDENTITY_AUDIENCE");
    identity = {
      mode: "zai-jwt",
      issuer: required("ZCODE_REMOTE_RELAY_IDENTITY_ISSUER"),
      ...(audience === undefined ? {} : { audience }),
      userClaim: optional("ZCODE_REMOTE_RELAY_IDENTITY_USER_CLAIM") ?? "sub",
      keys: jwkArray(
        "ZCODE_REMOTE_RELAY_IDENTITY_JWKS",
        required("ZCODE_REMOTE_RELAY_IDENTITY_JWKS"),
        true,
      ),
    };
  }
  return {
    warnings,
    server: {
      host,
      port,
      allowedOrigins: origins,
      trustedProxies: list("ZCODE_RELAY_TRUSTED_PROXIES"),
      maxConnections: integer("ZCODE_RELAY_MAX_CONNECTIONS", 2000),
      registrationsPerMinute: integer("ZCODE_RELAY_REGISTRATIONS_PER_MINUTE", 20),
      maxBufferedBytes: integer("ZCODE_RELAY_MAX_BUFFERED_BYTES", 2 * 1024 * 1024),
      maxTotalBufferedBytes: integer("ZCODE_RELAY_MAX_TOTAL_BUFFERED_BYTES", 64 * 1024 * 1024),
      authTimeoutMs: integer("ZCODE_REMOTE_RELAY_AUTH_TIMEOUT_MS", 15_000),
      identityLimits: {
        maxSockets: integer("ZCODE_RELAY_MAX_SOCKETS_PER_IDENTITY", 8),
        bytesPerDay: integer("ZCODE_RELAY_BYTES_PER_IDENTITY_PER_DAY", 512 * 1024 * 1024),
      },
    },
    store: {
      path: required("ZCODE_RELAY_DB_PATH"),
      maxRecords: integer("ZCODE_RELAY_MAX_REGISTRATIONS", 100_000),
      maxEnrolledKeys: integer("ZCODE_RELAY_MAX_ENROLLED_KEYS", 10_000),
      keyIdleExpiryDays: integer("ZCODE_RELAY_KEY_IDLE_EXPIRY_DAYS", 30),
    },
    session: {
      signingKeys: jwkArray(
        "ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS",
        required("ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS"),
      ),
      ttlSeconds,
      identity,
    },
  };
}
