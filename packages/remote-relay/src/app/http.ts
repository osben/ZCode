import {
  parseWebRemoteControlRelayV2HttpRequest,
  type WebRemoteControlRelayV2Device,
} from "@zcode/shared/web-remote-relay";
import type { RelayDeviceRecord, RelayDeviceStore, RelaySessionService } from "../contract.js";
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
  now: () => number;
}

const ok = (data?: unknown): RelayHttpResponse => ({
  status: 200,
  body: data === undefined ? { code: 0, msg: "ok" } : { code: 0, msg: "ok", data },
});
const fail = (status: number, code: number, msg: string): RelayHttpResponse => ({
  status,
  body: { code, msg },
});

const ROUTES: Record<string, { method: string }[]> = {
  [`${RELAY_API_PREFIX}/session`]: [{ method: "POST" }],
  [`${RELAY_API_PREFIX}/device`]: [{ method: "POST" }, { method: "GET" }],
  [`${RELAY_API_PREFIX}/device/delete`]: [{ method: "POST" }],
  [`${RELAY_API_PREFIX}/token`]: [{ method: "POST" }],
};

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
  const { devices, live, tokens, session } = dependencies;

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
      const identityToken = exchangeBody(request.body);
      if (request.bodyError || identityToken === undefined)
        return fail(400, 3001, "parameter error");
      const issued = session.exchange(identityToken);
      if (!issued) return fail(401, 401, "unauthorized");
      return ok({ jwt: issued.jwt, expires_in: issued.expiresIn });
    }

    const userId = request.bearer ? session.verify(request.bearer) : undefined;
    if (!userId) return fail(401, 401, "unauthorized");

    if (request.path === `${RELAY_API_PREFIX}/device` && request.method === "GET") {
      const records = await devices.listForUser(userId);
      return ok(records.map(view));
    }
    if (request.bodyError) return fail(400, 3001, "parameter error");

    if (request.path === `${RELAY_API_PREFIX}/device`) {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("register", request.body);
      if (!parsed) return fail(400, 3001, "parameter error");
      const record = await devices.register(
        userId,
        parsed.device_mid,
        Math.floor(dependencies.now() / 1000),
      );
      return ok(view(record));
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
    const issued = tokens.issue(userId, parsed.role);
    if (!issued) return fail(429, 4029, "too many outstanding tokens");
    return ok({ token: issued.token, expires_in: issued.expiresIn });
  }

  return {
    handle: route,
  };
}
