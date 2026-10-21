import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RelayHarness } from "./support/relayHarness.js";

const cleanup: RelayHarness[] = [];
afterEach(async () => {
  for (const harness of cleanup.splice(0)) await harness.close();
});

async function relay(overrides?: Parameters<typeof startRelay>[0]) {
  const harness = await startRelay(overrides);
  cleanup.push(harness);
  return harness;
}

describe("session exchange", () => {
  it("returns a relay JWT and the TTL for a valid login JWT, with no-store caching", async () => {
    const harness = await relay();
    const result = await harness.api("POST", "/api/v1/remote/session", {
      body: { identity_token: harness.login() },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toMatchObject({
      code: 0,
      msg: "ok",
      data: { expires_in: 3600 },
    });
  });

  it("answers 400 with code 3001 for a missing, extra-keyed or non-string body", async () => {
    const harness = await relay();
    for (const body of [undefined, {}, { identity_token: "x", extra: 1 }, { identity_token: 7 }]) {
      const result = await harness.api("POST", "/api/v1/remote/session", {
        body,
      });
      expect(result).toMatchObject({ status: 400, body: { code: 3001 } });
    }
    const malformed = await harness.api("POST", "/api/v1/remote/session", {
      rawBody: "{not json",
    });
    expect(malformed).toMatchObject({ status: 400, body: { code: 3001 } });
  });

  it("answers 401 with code 401 for an identity token the relay does not trust", async () => {
    const harness = await relay();
    const result = await harness.api("POST", "/api/v1/remote/session", {
      body: { identity_token: "aaa.bbb.ccc" },
    });
    expect(result).toMatchObject({ status: 401, body: { code: 401 } });
  });
});

describe("authentication of the relay API", () => {
  it("rejects a missing, malformed or forged relay JWT before any handler runs", async () => {
    const harness = await relay();
    const list = "/api/v1/remote/device";
    expect((await harness.api("GET", list)).status).toBe(401);
    expect((await harness.api("GET", list, { bearer: "not-a-jwt" })).status).toBe(401);
    const login = harness.login();
    expect((await harness.api("GET", list, { bearer: login })).status).toBe(401);
  });

  it("returns the 404 envelope for unknown routes and 405 for the wrong method", async () => {
    const harness = await relay();
    expect(await harness.api("GET", "/api/v1/remote/nothing")).toMatchObject({
      status: 404,
    });
    expect((await harness.api("GET", "/api/v1/remote/session")).status).toBe(405);
    expect((await harness.api("GET", "/api/v1/remote/token")).status).toBe(405);
  });
});

describe("device records", () => {
  it("registers a device with a new SID per call and lists it for its owner only", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt("user-1");
    const first = await harness.api("POST", "/api/v1/remote/device", {
      bearer,
      body: { device_mid: "mid-a" },
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      device_mid: "mid-a",
      online: false,
      meta: {},
    });
    const second = await harness.api("POST", "/api/v1/remote/device", {
      bearer,
      body: { device_mid: "mid-a" },
    });
    expect((second.body.data as { device_sid: string }).device_sid).not.toBe(
      (first.body.data as { device_sid: string }).device_sid,
    );

    const listed = await harness.api("GET", "/api/v1/remote/device", {
      bearer,
    });
    expect((listed.body.data as unknown[]).length).toBe(2);
    const other = await harness.api("GET", "/api/v1/remote/device", {
      bearer: await harness.relayJwt("user-2"),
    });
    expect(other.body.data).toEqual([]);
  });

  it("answers 400 with code 3001 for a register body without device_mid", async () => {
    const harness = await relay();
    const result = await harness.api("POST", "/api/v1/remote/device", {
      bearer: await harness.relayJwt(),
      body: { device_mid: "" },
    });
    expect(result).toMatchObject({ status: 400, body: { code: 3001 } });
  });

  it("deletes an offline device of the caller; an unknown SID succeeds idempotently", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    expect(
      await harness.api("POST", "/api/v1/remote/device/delete", {
        bearer,
        body: { device_sid: sid },
      }),
    ).toMatchObject({ status: 200, body: { code: 0 } });
    const listed = await harness.api("GET", "/api/v1/remote/device", {
      bearer,
    });
    expect(listed.body.data).toEqual([]);
    expect(
      await harness.api("POST", "/api/v1/remote/device/delete", {
        bearer,
        body: { device_sid: sid },
      }),
    ).toMatchObject({ status: 200, body: { code: 0 } });
    expect(
      await harness.api("POST", "/api/v1/remote/device/delete", {
        bearer,
        body: { device_sid: "unknown-sid" },
      }),
    ).toMatchObject({ status: 200, body: { code: 0 } });
  });

  it("refuses another account's device with HTTP 200 and code 1006, leaving it in place", async () => {
    const harness = await relay();
    const owner = await harness.relayJwt("user-1");
    const { device_sid: sid } = await harness.register(owner);
    const intruder = await harness.api("POST", "/api/v1/remote/device/delete", {
      bearer: await harness.relayJwt("user-2"),
      body: { device_sid: sid },
    });
    expect(intruder).toMatchObject({ status: 200, body: { code: 1006 } });
    const listed = await harness.api("GET", "/api/v1/remote/device", {
      bearer: owner,
    });
    expect(listed.body.data).toHaveLength(1);
  });

  it("answers 400 with code 3001 for a delete body without device_sid", async () => {
    const harness = await relay();
    const result = await harness.api("POST", "/api/v1/remote/device/delete", {
      bearer: await harness.relayJwt(),
      body: {},
    });
    expect(result).toMatchObject({ status: 400, body: { code: 3001 } });
  });
});

describe("one-time token endpoint", () => {
  it("issues a 22 character token for a valid role, bound to the caller", async () => {
    const harness = await relay();
    const result = await harness.api("POST", "/api/v1/remote/token", {
      bearer: await harness.relayJwt(),
      body: { role: "terminal" },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const data = result.body.data as { token: string; expires_in: number };
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(data.expires_in).toBe(60);
  });

  it("rejects an unknown role with code 3001", async () => {
    const harness = await relay();
    const result = await harness.api("POST", "/api/v1/remote/token", {
      bearer: await harness.relayJwt(),
      body: { role: "admin" },
    });
    expect(result).toMatchObject({ status: 400, body: { code: 3001 } });
  });

  it("answers 429 with code 4029 beyond 32 outstanding tokens for one user", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    for (let index = 0; index < 32; index += 1) {
      const issued = await harness.api("POST", "/api/v1/remote/token", {
        bearer,
        body: { role: "device" },
      });
      expect(issued.status).toBe(200);
    }
    expect(
      await harness.api("POST", "/api/v1/remote/token", {
        bearer,
        body: { role: "device" },
      }),
    ).toMatchObject({ status: 429, body: { code: 4029 } });
    expect(
      (
        await harness.api("POST", "/api/v1/remote/token", {
          bearer: await harness.relayJwt("user-2"),
          body: { role: "device" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("rate limits and origins", () => {
  it("limits anonymous writes per source address to the configured count per minute", async () => {
    const harness = await relay({ registrationsPerMinute: 2 });
    const session = { identity_token: harness.login() };
    expect((await harness.api("POST", "/api/v1/remote/session", { body: session })).status).toBe(
      200,
    );
    expect((await harness.api("POST", "/api/v1/remote/session", { body: session })).status).toBe(
      200,
    );
    expect(await harness.api("POST", "/api/v1/remote/session", { body: session })).toMatchObject({
      status: 429,
      body: { code: 4029 },
    });
    expect(
      await harness.api("POST", "/api/v1/remote/device", {
        bearer: harness.login(),
        body: { device_mid: "mid-a" },
      }),
    ).toMatchObject({ status: 429, body: { code: 4029 } });
  });

  it("echoes only allow-listed Web origins on CORS responses", async () => {
    const harness = await relay({
      allowedOrigins: ["https://zcode.example.invalid"],
    });
    const allowed = await harness.api("OPTIONS", "/api/v1/remote/session", {
      origin: "https://zcode.example.invalid",
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://zcode.example.invalid",
    );
    const denied = await harness.api("OPTIONS", "/api/v1/remote/session", {
      origin: "https://attacker.example.invalid",
    });
    expect(denied.status).toBe(204);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves health probes without authentication", async () => {
    const harness = await relay();
    expect(await harness.api("GET", "/healthz")).toMatchObject({ status: 200 });
    expect(await harness.api("GET", "/readyz")).toMatchObject({ status: 200 });
    expect(await harness.api("GET", "/elsewhere")).toMatchObject({
      status: 404,
    });
  });
});
