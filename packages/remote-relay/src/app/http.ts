import {
  parseWebRemoteControlRelayV2HttpRequest,
  type WebRemoteControlRelayV2Device,
} from "@zcode/shared/web-remote-relay";
import {
  ENROLLMENT_CLOSED_CODE,
  ENROLLMENT_NOT_ENROLLED_CODE,
  ENROLLMENT_POW_NONCE_PATTERN,
} from "@zcode/shared/web-remote-relay";
import {
  RelayLimitError,
  type RelayDeviceKeyExchange,
  type RelayDeviceRecord,
  type RelayDeviceStore,
  type RelaySessionService,
} from "../contract.js";
import type { IdentityLimits } from "../domain/identityLimits.js";
import type { RelayRegistry } from "./relay.js";
import type { RelayTokenStore } from "../domain/tokens.js";

export const RELAY_API_PREFIX = "/api/v1/remote";
const MAX_IDENTITY_TOKEN_LENGTH = 8192;

export interface RelayHttpRequest {
  method: string;
  path: string;
  /** Raw bearer value from the Authorization header, without the scheme. */
  bearer?: string;
  /** Parsed JSON body; undefined when the request had no body. */
  body: unknown;
  /** True when a body was present but was not valid JSON. */
  bodyError: boolean;
}

export interface RelayHttpResponse {
  status: number;
  body: { code: number; msg: string; data?: unknown };
}

export interface RelayHttpApi {
  handle(request: RelayHttpRequest): Promise<RelayHttpResponse>;
}

export interface RelayHttpApiDependencies {
  devices: RelayDeviceStore;
  live: Pick<RelayRegistry, "isOnline" | "metaOf" | "reserveDeletion" | "releaseDeletion">;
  tokens: RelayTokenStore;
  session: RelaySessionService;
  /** Per-identity quotas; consulted only for device-key JWTs, which carry a tier. */
  limits: Pick<IdentityLimits, "allowToken" | "overBudget" | "maxDevices">;
  now: () => number;
}

const ok = (data?: unknown): RelayHttpResponse => ({
  status: 200,
  body: data === undefined ? { code: 0, msg: "ok" } : { code: 0, msg: "ok", data },
});
const fail = (status: number, code: number, msg: string, data?: unknown): RelayHttpResponse => ({
  status,
  body: data === undefined ? { code, msg } : { code, msg, data },
});

const ROUTES: Record<string, { method: string }[]> = {
  [`${RELAY_API_PREFIX}/session`]: [{ method: "POST" }],
  [`${RELAY_API_PREFIX}/device`]: [{ method: "POST" }, { method: "GET" }],
  [`${RELAY_API_PREFIX}/device/delete`]: [{ method: "POST" }],
  [`${RELAY_API_PREFIX}/token`]: [{ method: "POST" }],
  [`${RELAY_API_PREFIX}/pairing`]: [{ method: "POST" }],
};

type ExchangeBody =
  | { kind: "identity-token"; identityToken: string }
  | { kind: "pairing"; code: string }
  | { kind: "device-key"; request: RelayDeviceKeyExchange };

const DEVICE_KEY_FIELDS = ["public_key", "ts", "nonce", "signature"];
const WORK_FIELDS = ["challenge", "nonce"];
const MAX_CHALLENGE_LENGTH = 64;
const sameKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
};

/** Strict per-mode body parser: a body of the other mode's shape is a parameter error. */
function parseExchangeBody(
  body: unknown,
  mode: RelaySessionService["mode"],
): ExchangeBody | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (mode === "zai-jwt") {
    const token = exchangeBody(body);
    return token === undefined ? undefined : { kind: "identity-token", identityToken: token };
  }
  if (sameKeys(body, ["pairing_code"])) {
    const code = (body as { pairing_code: unknown }).pairing_code;
    return typeof code === "string" && code.length > 0 && code.length <= 64
      ? { kind: "pairing", code }
      : undefined;
  }
  // Exactly one of three shapes; a secret and work together are ambiguous and rejected.
  const withSecret = sameKeys(body, ["device_key", "enrollment_secret"]);
  const withWork = sameKeys(body, ["device_key", "work"]);
  if (!withSecret && !withWork && !sameKeys(body, ["device_key"])) return undefined;
  const {
    device_key: deviceKey,
    enrollment_secret: secret,
    work,
  } = body as {
    device_key: unknown;
    enrollment_secret?: unknown;
    work?: unknown;
  };
  if (typeof deviceKey !== "object" || deviceKey === null || Array.isArray(deviceKey)) {
    return undefined;
  }
  if (!sameKeys(deviceKey, DEVICE_KEY_FIELDS)) return undefined;
  const { public_key: publicKey, ts, nonce, signature } = deviceKey as Record<string, unknown>;
  if (
    typeof publicKey !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string" ||
    typeof ts !== "number" ||
    publicKey.length > 64 ||
    nonce.length > 128 ||
    signature.length > 128
  ) {
    return undefined;
  }
  if (withSecret && (typeof secret !== "string" || secret.length > 1024)) return undefined;
  let parsedWork: { challenge: string; nonce: string } | undefined;
  if (withWork) {
    if (typeof work !== "object" || work === null || Array.isArray(work)) return undefined;
    if (!sameKeys(work, WORK_FIELDS)) return undefined;
    const { challenge, nonce: counter } = work as Record<string, unknown>;
    if (
      typeof challenge !== "string" ||
      challenge.length > MAX_CHALLENGE_LENGTH ||
      typeof counter !== "string" ||
      !ENROLLMENT_POW_NONCE_PATTERN.test(counter)
    ) {
      return undefined;
    }
    parsedWork = { challenge, nonce: counter };
  }
  return {
    kind: "device-key",
    request: {
      publicKey,
      ts,
      nonce,
      signature,
      ...(withSecret ? { enrollmentSecret: secret as string } : {}),
      ...(parsedWork === undefined ? {} : { work: parsedWork }),
    },
  };
}

function exchangeBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "identity_token") return undefined;
  const token = (body as { identity_token: unknown }).identity_token;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_IDENTITY_TOKEN_LENGTH) {
    return undefined;
  }
  return token;
}

/**
 * HTTP business rules for the V2 API. Pure orchestration over injected ports: no sockets, no
 * clocks of its own. Device lookups go through the registry so `online` and `meta` describe live state.
 */
export function createRelayHttpApi(dependencies: RelayHttpApiDependencies): RelayHttpApi {
  const { devices, live, tokens, session, limits } = dependencies;

  const view = (record: RelayDeviceRecord): WebRemoteControlRelayV2Device => ({
    device_sid: record.deviceSid,
    device_mid: record.deviceMid,
    online: live.isOnline(record.deviceSid),
    created_at: record.createdAt,
    meta: live.metaOf(record.deviceSid),
  });

  async function route(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const routes = ROUTES[request.path];
    if (!routes) return fail(404, 404, "not found");
    if (!routes.some((entry) => entry.method === request.method)) {
      return fail(405, 405, "method not allowed");
    }
    if (request.path === `${RELAY_API_PREFIX}/session`) {
      const parsed = request.bodyError ? undefined : parseExchangeBody(request.body, session.mode);
      if (!parsed) return fail(400, 3001, "parameter error");
      if (parsed.kind === "device-key") {
        const outcome = await session.exchangeDeviceKey(parsed.request);
        if (outcome.status === "not-enrolled") {
          return outcome.challenge === undefined
            ? fail(401, ENROLLMENT_NOT_ENROLLED_CODE, "not enrolled")
            : fail(401, ENROLLMENT_NOT_ENROLLED_CODE, "not enrolled", {
                challenge: outcome.challenge.challenge,
                difficulty: outcome.challenge.difficulty,
                expires_in: outcome.challenge.expiresIn,
              });
        }
        if (outcome.status === "closed") {
          return fail(503, ENROLLMENT_CLOSED_CODE, "enrollment closed");
        }
        if (outcome.status === "busy") return fail(503, 503, "unavailable");
        if (outcome.status !== "ok") return fail(401, 401, "unauthorized");
        return ok({
          jwt: outcome.session.jwt,
          expires_in: outcome.session.expiresIn,
        });
      }
      const issued =
        parsed.kind === "pairing"
          ? session.exchangePairing(parsed.code)
          : session.exchange(parsed.identityToken);
      if (!issued) return fail(401, 401, "unauthorized");
      return ok({ jwt: issued.jwt, expires_in: issued.expiresIn });
    }
    if (request.path === `${RELAY_API_PREFIX}/pairing` && session.mode !== "device-key") {
      return fail(404, 404, "not found");
    }

    const claims = request.bearer ? session.claims(request.bearer) : undefined;
    if (!claims) return fail(401, 401, "unauthorized");
    const userId = claims.userId;

    if (request.path === `${RELAY_API_PREFIX}/device` && request.method === "GET") {
      const records = await devices.listForUser(userId);
      return ok(records.map(view));
    }
    if (request.bodyError) return fail(400, 3001, "parameter error");

    if (request.path === `${RELAY_API_PREFIX}/pairing`) {
      // Only the enrolled device identity may mint codes; a pairing-derived JWT cannot renew itself.
      if (claims.viaPairing || claims.tier === undefined) return fail(401, 401, "unauthorized");
      const issued = session.createPairing(userId, claims.tier);
      if (!issued) return fail(429, 4029, "too many outstanding pairing codes");
      return ok({ code: issued.code, expires_in: issued.expiresIn });
    }

    if (request.path === `${RELAY_API_PREFIX}/device`) {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("register", request.body);
      if (!parsed) return fail(400, 3001, "parameter error");
      try {
        const record = await devices.register(
          userId,
          parsed.device_mid,
          Math.floor(dependencies.now() / 1000),
          claims.tier === undefined ? undefined : limits.maxDevices(claims.tier),
        );
        return ok(view(record));
      } catch (error) {
        if (error instanceof RelayLimitError) return fail(429, 4029, "too many devices");
        throw error;
      }
    }

    if (request.path === `${RELAY_API_PREFIX}/device/delete`) {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("delete", request.body);
      if (!parsed) return fail(400, 3001, "parameter error");
      const record = await devices.get(parsed.device_sid);
      // Unknown SIDs succeed so retries after a lost response are harmless.
      if (!record) return ok();
      if (record.userId !== userId)
        return { status: 200, body: { code: 1006, msg: "no permission" } };
      if (!live.reserveDeletion(record.deviceSid)) return fail(400, 3005, "wrong status");
      try {
        await devices.remove(record.deviceSid);
      } finally {
        live.releaseDeletion(record.deviceSid);
      }
      return ok();
    }

    const parsed = parseWebRemoteControlRelayV2HttpRequest("token", request.body);
    if (!parsed) return fail(400, 3001, "parameter error");
    // A phone that scanned a QR holds a pairing JWT; it must never take the Desktop slot.
    if (claims.viaPairing && parsed.role === "device") {
      return fail(403, 1006, "no permission");
    }
    if (claims.tier !== undefined) {
      if (!limits.allowToken(userId, claims.tier)) return fail(429, 4029, "rate limited");
      if (limits.overBudget(userId, claims.tier)) return fail(429, 4029, "daily budget spent");
    }
    const issued = tokens.issue(userId, parsed.role, {
      ...(claims.tier === undefined ? {} : { tier: claims.tier }),
      ...(claims.viaPairing ? { closeAtMs: claims.expiresAt * 1000 } : {}),
    });
    if (!issued) return fail(429, 4029, "too many outstanding tokens");
    return ok({ token: issued.token, expires_in: issued.expiresIn });
  }

  return {
    handle: route,
  };
}
