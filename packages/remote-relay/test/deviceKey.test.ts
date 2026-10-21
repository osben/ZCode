import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRelaySessionService } from "../src/adapters/session.js";
import {
  deviceKeyBody,
  deviceKeyPair,
  ENROLLMENT_SECRET,
  identityKey,
  ISSUER,
  loginJwt,
  NOW_SECONDS,
  relaySigningKey,
} from "./support/keys.js";
import { startRelay, type RelayHarness } from "./support/relayHarness.js";

const cleanup: RelayHarness[] = [];
afterEach(async () => {
  for (const harness of cleanup.splice(0)) await harness.close();
});

async function deviceRelay(overrides: Parameters<typeof startRelay>[0] = {}) {
  const harness = await startRelay({ identityMode: "device-key", ...overrides });
  cleanup.push(harness);
  return harness;
}

const SESSION = "/api/v1/remote/session";
const now = () => Math.floor(Date.now() / 1000);
const subjectOf = (jwt: string) =>
  (JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { sub: string })
    .sub;
const derivedId = (publicKey: string) =>
  `dk:${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url")}`;

describe("device-key enrollment and exchange", () => {
  it("enrolls an unknown key with the secret, derives the user id, and later needs no secret", async () => {
    const harness = await deviceRelay();
    const pair = deviceKeyPair();
    const first = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair, { secret: ENROLLMENT_SECRET }),
    });
    expect(first).toMatchObject({ status: 200, body: { code: 0, data: { expires_in: 3600 } } });
    const jwt = (first.body.data as { jwt: string }).jwt;
    expect(subjectOf(jwt)).toBe(derivedId(pair.publicKey));
    const second = await harness.api("POST", SESSION, { body: deviceKeyBody(pair) });
    expect(second.status).toBe(200);
    // The issued relay JWT works on the unchanged device routes.
    const registered = await harness.api("POST", "/api/v1/remote/device", {
      bearer: jwt,
      body: { device_mid: "mid-1" },
    });
    expect(registered.status).toBe(200);
  });

  it("answers 4012 for an unknown key without a secret and enrolls nothing", async () => {
    const harness = await deviceRelay();
    const pair = deviceKeyPair();
    const result = await harness.api("POST", SESSION, { body: deviceKeyBody(pair) });
    expect(result).toMatchObject({ status: 401, body: { code: 4012 } });
    const retry = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair, { secret: ENROLLMENT_SECRET }),
    });
    expect(retry.status).toBe(200);
  });

  it("rejects a wrong enrollment secret of equal and of different length with the generic 401", async () => {
    const harness = await deviceRelay();
    const sameLength = "x".repeat(ENROLLMENT_SECRET.length);
    for (const secret of [sameLength, "short", ENROLLMENT_SECRET + "extra", ""]) {
      const result = await harness.api("POST", SESSION, {
        body: deviceKeyBody(deviceKeyPair(), { secret }),
      });
      expect(result).toMatchObject({ status: 401, body: { code: 401, msg: "unauthorized" } });
      expect(JSON.stringify(result.body)).not.toContain(secret || "\u0000");
    }
  });

  it("rejects a replayed challenge, even though the first use succeeded", async () => {
    const harness = await deviceRelay();
    const body = deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET });
    expect((await harness.api("POST", SESSION, { body })).status).toBe(200);
    expect((await harness.api("POST", SESSION, { body })).status).toBe(401);
  });

  it("rejects expired and future timestamps", async () => {
    const harness = await deviceRelay();
    const pair = deviceKeyPair();
    for (const ts of [now() - 120, now() + 120]) {
      const result = await harness.api("POST", SESSION, {
        body: deviceKeyBody(pair, { ts, secret: ENROLLMENT_SECRET }),
      });
      expect(result.status).toBe(401);
    }
    const fresh = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair, { ts: now() - 30, secret: ENROLLMENT_SECRET }),
    });
    expect(fresh.status).toBe(200);
  });

  it("rejects key substitution: a signature from key B under key A's public key", async () => {
    const harness = await deviceRelay();
    const victim = deviceKeyPair();
    const attacker = deviceKeyPair();
    await harness.api("POST", SESSION, {
      body: deviceKeyBody(victim, { secret: ENROLLMENT_SECRET }),
    });
    const forged = await harness.api("POST", SESSION, {
      body: deviceKeyBody(victim, { signWith: attacker.privateKey }),
    });
    expect(forged.status).toBe(401);
    // Even with a valid secret, a signature that does not match the claimed key never enrolls.
    const forgedEnroll = await harness.api("POST", SESSION, {
      body: deviceKeyBody(deviceKeyPair(), {
        signWith: attacker.privateKey,
        secret: ENROLLMENT_SECRET,
      }),
    });
    expect(forgedEnroll.status).toBe(401);
  });

  it("rejects a tampered nonce or timestamp after signing", async () => {
    const harness = await deviceRelay();
    const pair = deviceKeyPair();
    const body = deviceKeyBody(pair, { secret: ENROLLMENT_SECRET }) as {
      device_key: { nonce: string; ts: number };
    };
    const tamperedNonce = structuredClone(body);
    tamperedNonce.device_key.nonce = "A".repeat(22);
    expect((await harness.api("POST", SESSION, { body: tamperedNonce })).status).toBe(401);
    const tamperedTs = structuredClone(body);
    tamperedTs.device_key.ts += 1;
    expect((await harness.api("POST", SESSION, { body: tamperedTs })).status).toBe(401);
  });

  it("rejects malformed bodies with 400/3001", async () => {
    const harness = await deviceRelay();
    const pair = deviceKeyPair();
    const good = deviceKeyBody(pair, { secret: ENROLLMENT_SECRET }) as {
      device_key: Record<string, unknown>;
    };
    const bodies: unknown[] = [
      {},
      { device_key: {} },
      { ...good, extra: 1 },
      { device_key: { ...good.device_key, extra: 1 } },
      { device_key: { ...good.device_key, ts: "1" } },
      { ...good, enrollment_secret: 7 },
    ];
    for (const body of bodies) {
      expect(await harness.api("POST", SESSION, { body })).toMatchObject({
        status: 400,
        body: { code: 3001 },
      });
    }
  });

  it("rejects well-typed but malformed key, nonce or signature fields with the generic 401", async () => {
    const harness = await deviceRelay();
    const good = deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET }) as {
      device_key: Record<string, unknown>;
    };
    for (const field of [{ public_key: "short" }, { nonce: "tiny" }, { signature: "sig" }]) {
      const body = { ...good, device_key: { ...good.device_key, ...field } };
      expect((await harness.api("POST", SESSION, { body })).status).toBe(401);
    }
  });

  it("applies the shared per-IP limiter to the exchange", async () => {
    const harness = await deviceRelay({ registrationsPerMinute: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push(
        (await harness.api("POST", SESSION, { body: deviceKeyBody(deviceKeyPair()) })).status,
      );
    }
    expect(statuses).toEqual([401, 401, 429]);
  });
});

describe("secret hygiene", () => {
  it("never writes the enrollment secret or pairing codes to logs or error bodies", async () => {
    const events: string[] = [];
    const logger = {
      info: (event: string) => events.push(event),
      warn: (event: string) => events.push(event),
      error: (event: string) => events.push(event),
    };
    const harness = await deviceRelay({ logger });
    const results = [
      await harness.api("POST", SESSION, {
        body: deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET + "x" }),
      }),
      await harness.api("POST", SESSION, { rawBody: ENROLLMENT_SECRET }),
      await harness.api("POST", SESSION, { body: { pairing_code: "B".repeat(22) } }),
    ];
    const everything = JSON.stringify([events, results.map((result) => result.body)]);
    expect(everything).not.toContain(ENROLLMENT_SECRET);
    expect(everything).not.toContain("B".repeat(22));
  });
});

describe("cross-mode rejection", () => {
  it("rejects a login-JWT body in device-key mode and a device-key body in zai-jwt mode", async () => {
    const device = await deviceRelay();
    const zai = await startRelay();
    cleanup.push(zai);
    const login = zai.login();
    expect((await device.api("POST", SESSION, { body: { identity_token: login } })).status).toBe(
      400,
    );
    const body = deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET });
    expect((await zai.api("POST", SESSION, { body })).status).toBe(400);
  });

  it("rejects relay JWTs minted by the other mode when both share one signing key", async () => {
    const signingKey = relaySigningKey("shared").privateJwk;
    const device = await deviceRelay({ signingKey });
    const zai = await startRelay({ signingKey });
    cleanup.push(zai);
    const zaiJwt = await zai.relayJwt("user-1");
    const deviceJwt = (
      (
        await device.api("POST", SESSION, {
          body: deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET }),
        })
      ).body.data as { jwt: string }
    ).jwt;
    expect((await device.api("GET", "/api/v1/remote/device", { bearer: zaiJwt })).status).toBe(401);
    expect((await zai.api("GET", "/api/v1/remote/device", { bearer: deviceJwt })).status).toBe(401);
    // Sanity: each JWT is valid on its own relay.
    expect((await device.api("GET", "/api/v1/remote/device", { bearer: deviceJwt })).status).toBe(
      200,
    );
    expect((await zai.api("GET", "/api/v1/remote/device", { bearer: zaiJwt })).status).toBe(200);
  });

  it("refuses a login subject that claims the reserved dk: prefix in zai-jwt mode", async () => {
    const zai = await startRelay();
    cleanup.push(zai);
    const result = await zai.api("POST", SESSION, {
      body: { identity_token: zai.login("dk:someone") },
    });
    expect(result.status).toBe(401);
  });
});

describe("pairing codes for the phone", () => {
  async function paired(harness: RelayHarness) {
    const pair = deviceKeyPair();
    const jwt = (
      (
        await harness.api("POST", SESSION, {
          body: deviceKeyBody(pair, { secret: ENROLLMENT_SECRET }),
        })
      ).body.data as { jwt: string }
    ).jwt;
    const code = (
      (await harness.api("POST", "/api/v1/remote/pairing", { bearer: jwt, body: {} })).body
        .data as { code: string }
    ).code;
    return { pair, jwt, code };
  }

  it("issues a 128-bit, 300 second code and lets the phone exchange it for the same user id", async () => {
    const harness = await deviceRelay();
    const { pair, jwt, code } = await paired(harness);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const phone = await harness.api("POST", SESSION, { body: { pairing_code: code } });
    expect(phone.status).toBe(200);
    const phoneJwt = (phone.body.data as { jwt: string }).jwt;
    expect(subjectOf(phoneJwt)).toBe(derivedId(pair.publicKey));
    // The phone sees the Desktop's devices through the unchanged routes.
    const registered = await harness.api("POST", "/api/v1/remote/device", {
      bearer: jwt,
      body: { device_mid: "mid-1" },
    });
    const listed = await harness.api("GET", "/api/v1/remote/device", { bearer: phoneJwt });
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        device_sid: (registered.body.data as { device_sid: string }).device_sid,
      }),
    ]);
  });

  it("rejects reuse of a spent code, an unknown code and a malformed body", async () => {
    const harness = await deviceRelay();
    const { code } = await paired(harness);
    expect((await harness.api("POST", SESSION, { body: { pairing_code: code } })).status).toBe(200);
    expect((await harness.api("POST", SESSION, { body: { pairing_code: code } })).status).toBe(401);
    expect(
      (await harness.api("POST", SESSION, { body: { pairing_code: "A".repeat(22) } })).status,
    ).toBe(401);
    expect(
      (await harness.api("POST", SESSION, { body: { pairing_code: code, extra: 1 } })).status,
    ).toBe(400);
  });

  it("requires a relay JWT for /pairing and does not exist in zai-jwt mode", async () => {
    const harness = await deviceRelay();
    expect((await harness.api("POST", "/api/v1/remote/pairing", { body: {} })).status).toBe(401);
    const zai = await startRelay();
    cleanup.push(zai);
    const bearer = await zai.relayJwt();
    expect(await zai.api("POST", "/api/v1/remote/pairing", { bearer, body: {} })).toMatchObject({
      status: 404,
    });
    expect(
      (await zai.api("POST", SESSION, { body: { pairing_code: "A".repeat(22) } })).status,
    ).toBe(400);
  });

  it("refuses to mint pairing codes from a pairing-derived JWT so a phone cannot renew itself", async () => {
    const harness = await deviceRelay();
    const { jwt, code } = await paired(harness);
    const phoneJwt = (
      (await harness.api("POST", SESSION, { body: { pairing_code: code } })).body.data as {
        jwt: string;
      }
    ).jwt;
    const claims = JSON.parse(Buffer.from(phoneJwt.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims.amr).toEqual(["pairing"]);
    const denied = await harness.api("POST", "/api/v1/remote/pairing", {
      bearer: phoneJwt,
      body: {},
    });
    expect(denied.status).toBe(401);
    // The Desktop's own device-key JWT still can, and the phone JWT keeps working elsewhere.
    expect(
      (await harness.api("POST", "/api/v1/remote/pairing", { bearer: jwt, body: {} })).status,
    ).toBe(200);
    expect((await harness.api("GET", "/api/v1/remote/device", { bearer: phoneJwt })).status).toBe(
      200,
    );
  });

  it("caps outstanding codes per user", async () => {
    const harness = await deviceRelay();
    const { jwt } = await paired(harness);
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      statuses.push(
        (await harness.api("POST", "/api/v1/remote/pairing", { bearer: jwt, body: {} })).status,
      );
    }
    expect(statuses.slice(-1)).toEqual([429]);
  });
});

describe("service-level clock and capacity rules", () => {
  function keyStore() {
    const keys = new Map<string, "owner" | "open">();
    return {
      lookup: async (key: string) => ({ tier: keys.get(key), openKeys: 0 }),
      enroll: async (key: string, _createdAt: number, tier: "owner" | "open") =>
        void keys.set(key, tier),
      touch: async () => undefined,
    };
  }
  function build(clock: { ms: number }, extra: { maxReplayEntries?: number } = {}) {
    return createRelaySessionService({
      signingKeys: [relaySigningKey("relay-1").privateJwk],
      ttlSeconds: 3600,
      identity: { mode: "device-key", enrollmentSecret: ENROLLMENT_SECRET, keys: keyStore() },
      now: () => clock.ms,
      ...extra,
    });
  }
  const request = (pair: ReturnType<typeof deviceKeyPair>, ts: number, nonce: string) => {
    const body = deviceKeyBody(pair, { ts, nonce, secret: ENROLLMENT_SECRET }) as {
      device_key: { public_key: string; ts: number; nonce: string; signature: string };
    };
    return {
      publicKey: body.device_key.public_key,
      ts,
      nonce,
      signature: body.device_key.signature,
      enrollmentSecret: ENROLLMENT_SECRET,
    };
  };

  it("expires pairing codes after 300 seconds", () => {
    const clock = { ms: NOW_SECONDS * 1000 };
    const service = build(clock);
    const issued = service.createPairing("dk:user", "open")!;
    expect(issued.expiresIn).toBe(300);
    clock.ms += 299_000;
    expect(service.exchangePairing(issued.code)).toBeDefined();
    const second = service.createPairing("dk:user", "open")!;
    clock.ms += 301_000;
    expect(service.exchangePairing(second.code)).toBeUndefined();
  });

  it("fails closed when the replay cache is full, without evicting entries", async () => {
    const clock = { ms: NOW_SECONDS * 1000 };
    const service = build(clock, { maxReplayEntries: 2 });
    const pair = deviceKeyPair();
    const ts = NOW_SECONDS;
    const first = request(pair, ts, "a".repeat(22));
    expect((await service.exchangeDeviceKey(first)).status).toBe("ok");
    expect((await service.exchangeDeviceKey(request(pair, ts, "b".repeat(22)))).status).toBe("ok");
    expect((await service.exchangeDeviceKey(request(pair, ts, "c".repeat(22)))).status).toBe(
      "busy",
    );
    // The oldest entry is still remembered, so it cannot be replayed to make room.
    expect((await service.exchangeDeviceKey(first)).status).toBe("denied");
    clock.ms += 200_000;
    expect((await service.exchangeDeviceKey(request(pair, ts + 200, "c".repeat(22)))).status).toBe(
      "ok",
    );
  });

  it("does not throw or short-circuit on secrets of unequal length", async () => {
    const service = build({ ms: NOW_SECONDS * 1000 });
    for (const secret of ["", "a", "a".repeat(10_000)]) {
      const outcome = await service.exchangeDeviceKey({
        ...request(deviceKeyPair(), NOW_SECONDS, "n".repeat(22)),
        enrollmentSecret: secret,
      });
      expect(["denied", "not-enrolled"]).toContain(outcome.status);
    }
  });

  it("is inert for identity tokens in device-key mode", () => {
    const service = build({ ms: NOW_SECONDS * 1000 });
    const key = identityKey("EdDSA", "login-1");
    expect(service.exchange(loginJwt(key, "EdDSA"))).toBeUndefined();
    expect(ISSUER).toBeTruthy();
  });
});
