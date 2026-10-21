import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { enrollmentPowHashInput, hasLeadingZeroBits } from "@zcode/shared/web-remote-relay";
import { afterEach, describe, expect, it } from "vitest";
import { createRelaySessionService } from "../src/adapters/session.js";
import {
  deviceKeyBody,
  deviceKeyPair,
  ENROLLMENT_SECRET,
  NOW_SECONDS,
  relaySigningKey,
  solveWork,
  type DeviceKeyPair,
} from "./support/keys.js";
import { startRelay, type RelayHarness } from "./support/relayHarness.js";

const SESSION = "/api/v1/remote/session";
const DIFFICULTY = 12;
const cleanup: RelayHarness[] = [];
afterEach(async () => {
  for (const harness of cleanup.splice(0)) await harness.close();
});

async function openRelay(overrides: Parameters<typeof startRelay>[0] = {}) {
  const harness = await startRelay({
    identityMode: "device-key",
    enrollment: { mode: "open", difficulty: DIFFICULTY },
    ...overrides,
  });
  cleanup.push(harness);
  return harness;
}

const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as {
    tier?: string;
    amr?: string[];
  };

async function challengeFor(harness: RelayHarness, pair: DeviceKeyPair) {
  const result = await harness.api("POST", SESSION, {
    body: deviceKeyBody(pair),
  });
  expect(result).toMatchObject({ status: 401, body: { code: 4012 } });
  return result.body.data as {
    challenge: string;
    difficulty: number;
    expires_in: number;
  };
}

async function enrollOpen(harness: RelayHarness, pair: DeviceKeyPair) {
  const { challenge, difficulty } = await challengeFor(harness, pair);
  const work = solveWork(pair.publicKey, challenge, difficulty);
  return harness.api("POST", SESSION, { body: deviceKeyBody(pair, { work }) });
}

/** A nonce whose hash misses the difficulty, so rejection tests are not flaky. */
function failingWork(pair: DeviceKeyPair, challenge: string) {
  for (let counter = 0; ; counter += 1) {
    const nonce = `${counter}`;
    const hash = createHash("sha256")
      .update(enrollmentPowHashInput(pair.publicKey, challenge, nonce))
      .digest();
    if (!hasLeadingZeroBits(hash, DIFFICULTY)) return { challenge, nonce };
  }
}

describe("open enrollment by proof of work", () => {
  it("offers a challenge, enrolls an open-tier key, and needs no work afterwards", async () => {
    const harness = await openRelay();
    const pair = deviceKeyPair();
    const challenge = await challengeFor(harness, pair);
    expect(challenge).toMatchObject({ difficulty: DIFFICULTY, expires_in: 60 });
    const enrolled = await enrollOpen(harness, pair);
    expect(enrolled.status).toBe(200);
    expect(claimsOf((enrolled.body.data as { jwt: string }).jwt).tier).toBe("open");
    const again = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair),
    });
    expect(again.status).toBe(200);
  });

  it("gives secret mode no challenge and denies work there", async () => {
    const harness = await openRelay({ enrollment: { mode: "secret" } });
    const pair = deviceKeyPair();
    const plain = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair),
    });
    expect(plain).toMatchObject({ status: 401, body: { code: 4012 } });
    expect(plain.body.data).toBeUndefined();
    const work = solveWork(pair.publicKey, "A".repeat(34), 1);
    const denied = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair, { work }),
    });
    expect(denied).toMatchObject({ status: 401, body: { code: 401 } });
  });

  it("rejects insufficient work, another key's challenge, and a tampered challenge", async () => {
    const harness = await openRelay();
    const pair = deviceKeyPair();
    const { challenge } = await challengeFor(harness, pair);
    const bad = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair, { work: failingWork(pair, challenge) }),
    });
    expect(bad.status).toBe(401);

    const other = deviceKeyPair();
    const stolen = solveWork(pair.publicKey, challenge, DIFFICULTY);
    const crossKey = await harness.api("POST", SESSION, {
      body: deviceKeyBody(other, { work: stolen }),
    });
    expect(crossKey.status).toBe(401);

    const middle = Math.floor(challenge.length / 2);
    const flipped = `${challenge.slice(0, middle)}${challenge[middle] === "A" ? "B" : "A"}${challenge.slice(middle + 1)}`;
    const tampered = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair, {
        work: solveWork(pair.publicKey, flipped, DIFFICULTY),
      }),
    });
    expect(tampered.status).toBe(401);
    // Nothing above enrolled the key.
    expect((await harness.api("POST", SESSION, { body: deviceKeyBody(pair) })).body.code).toBe(
      4012,
    );
  });

  it("rejects a challenge issued by another relay process", async () => {
    const first = await openRelay();
    const second = await openRelay();
    const pair = deviceKeyPair();
    const { challenge } = await challengeFor(first, pair);
    const work = solveWork(pair.publicKey, challenge, DIFFICULTY);
    const result = await second.api("POST", SESSION, {
      body: deviceKeyBody(pair, { work }),
    });
    expect(result.status).toBe(401);
  });

  it("expires a challenge after 60 seconds", async () => {
    const clock = { ms: NOW_SECONDS * 1000 };
    const keys = new Map<string, "owner" | "open">();
    const service = createRelaySessionService({
      signingKeys: [relaySigningKey("relay-1").privateJwk],
      ttlSeconds: 3600,
      identity: {
        mode: "device-key",
        enrollment: { mode: "open", difficulty: DIFFICULTY },
        keys: {
          lookup: async (key) => ({ tier: keys.get(key), openKeys: 0 }),
          enroll: async (key, _at, tier) => void keys.set(key, tier),
          touch: async () => undefined,
        },
      },
      now: () => clock.ms,
    });
    const pair = deviceKeyPair();
    const asRequest = (body: Record<string, unknown>) => {
      const key = body.device_key as {
        public_key: string;
        ts: number;
        nonce: string;
        signature: string;
      };
      return {
        publicKey: key.public_key,
        ts: key.ts,
        nonce: key.nonce,
        signature: key.signature,
        ...(body.work ? { work: body.work as { challenge: string; nonce: string } } : {}),
      };
    };
    const first = await service.exchangeDeviceKey(
      asRequest(deviceKeyBody(pair, { ts: NOW_SECONDS })),
    );
    if (first.status !== "not-enrolled" || !first.challenge)
      throw new Error("expected a challenge");
    const work = solveWork(pair.publicKey, first.challenge.challenge, DIFFICULTY);
    clock.ms += 61_000;
    const late = await service.exchangeDeviceKey(
      asRequest(deviceKeyBody(pair, { ts: NOW_SECONDS + 61, work })),
    );
    expect(late.status).toBe("denied");
    clock.ms -= 20_000;
    const inTime = await service.exchangeDeviceKey(
      asRequest(deviceKeyBody(pair, { ts: NOW_SECONDS + 41, work })),
    );
    expect(inTime.status).toBe("ok");
  });

  it("keeps the body parser strict about work", async () => {
    const harness = await openRelay();
    const pair = deviceKeyPair();
    const { challenge } = await challengeFor(harness, pair);
    const work = solveWork(pair.publicKey, challenge, DIFFICULTY);
    const base = deviceKeyBody(pair, { work }) as Record<string, unknown>;
    const bodies: unknown[] = [
      { ...base, enrollment_secret: ENROLLMENT_SECRET },
      { ...base, extra: 1 },
      { ...base, work: { ...work, extra: 1 } },
      { ...base, work: { challenge: work.challenge } },
      { ...base, work: { ...work, nonce: "12ab" } },
      { ...base, work: { ...work, nonce: "1".repeat(17) } },
      { ...base, work: { ...work, nonce: 5 } },
      { ...base, work: "x" },
    ];
    for (const body of bodies) {
      expect(await harness.api("POST", SESSION, { body })).toMatchObject({
        status: 400,
        body: { code: 3001 },
      });
    }
  });

  it("refuses a replayed solved request", async () => {
    const harness = await openRelay();
    const pair = deviceKeyPair();
    const { challenge } = await challengeFor(harness, pair);
    const work = solveWork(pair.publicKey, challenge, DIFFICULTY);
    const body = deviceKeyBody(pair, { work });
    expect((await harness.api("POST", SESSION, { body })).status).toBe(200);
    expect((await harness.api("POST", SESSION, { body })).status).toBe(401);
  });

  it("still enrolls an owner key with the secret when open mode is on", async () => {
    const harness = await openRelay();
    const pair = deviceKeyPair();
    const result = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair, { secret: ENROLLMENT_SECRET }),
    });
    expect(claimsOf((result.body.data as { jwt: string }).jwt).tier).toBe("owner");
    const wrong = await harness.api("POST", SESSION, {
      body: deviceKeyBody(deviceKeyPair(), { secret: "x".repeat(40) }),
    });
    expect(wrong.status).toBe(401);
  });

  it("denies the secret when open mode has no secret configured", async () => {
    const harness = await openRelay({
      enrollment: { mode: "open", difficulty: DIFFICULTY, secret: false },
    });
    const denied = await harness.api("POST", SESSION, {
      body: deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET }),
    });
    expect(denied.status).toBe(401);
  });
});

describe("enrollment breaker", () => {
  it("stops new open enrollment at the key cap before any challenge, and spares existing keys", async () => {
    const harness = await openRelay({ maxEnrolledKeys: 1 });
    const first = deviceKeyPair();
    expect((await enrollOpen(harness, first)).status).toBe(200);
    const second = deviceKeyPair();
    const closed = await harness.api("POST", SESSION, {
      body: deviceKeyBody(second),
    });
    expect(closed).toMatchObject({ status: 503, body: { code: 4503 } });
    expect(closed.body.data).toBeUndefined();
    expect((await harness.api("POST", SESSION, { body: deviceKeyBody(first) })).status).toBe(200);
    const owner = await harness.api("POST", SESSION, {
      body: deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET }),
    });
    expect(owner.status).toBe(200);
  });

  it("opens on the hourly enrollment rate and rejects work solved before it opened", async () => {
    const harness = await openRelay({
      enrollment: {
        mode: "open",
        difficulty: DIFFICULTY,
        enrollmentsPerHour: 1,
      },
    });
    const late = deviceKeyPair();
    const { challenge } = await challengeFor(harness, late);
    expect((await enrollOpen(harness, deviceKeyPair())).status).toBe(200);
    const work = solveWork(late.publicKey, challenge, DIFFICULTY);
    const result = await harness.api("POST", SESSION, {
      body: deviceKeyBody(late, { work }),
    });
    expect(result).toMatchObject({ status: 503, body: { code: 4503 } });
  });
});

describe("key tiers and idle expiry", () => {
  it("treats a key without a usage row as owner", async () => {
    const harness = await openRelay();
    const pair = deviceKeyPair();
    const database = new DatabaseSync(harness.dbPath);
    database
      .prepare("INSERT INTO fork_relay_device_keys (public_key, created_at) VALUES (?, ?)")
      .run(pair.publicKey, 1);
    database.close();
    const result = await harness.api("POST", SESSION, {
      body: deviceKeyBody(pair),
    });
    expect(claimsOf((result.body.data as { jwt: string }).jwt).tier).toBe("owner");
  });

  it("expires only idle open keys, with their devices", async () => {
    const harness = await openRelay();
    const stale = deviceKeyPair();
    const owner = deviceKeyPair();
    const fresh = deviceKeyPair();
    await harness.store.enroll(stale.publicKey, 100, "open");
    await harness.store.enroll(owner.publicKey, 100, "owner");
    await harness.store.enroll(fresh.publicKey, 10_000, "open");
    const staleJwt = (await harness.api("POST", SESSION, { body: deviceKeyBody(stale) })).body
      .data as { jwt: string };
    await harness.store.touch(stale.publicKey, 100);
    await harness.register(staleJwt.jwt);
    // The exchange above touched last_seen to now; push it back so the key is idle.
    const database = new DatabaseSync(harness.dbPath);
    database
      .prepare(
        "UPDATE fork_relay_identity_usage SET last_seen = 100 WHERE tier = 'open' AND public_key = ?",
      )
      .run(stale.publicKey);
    database.close();
    expect(await harness.store.sweepIdleKeys(5_000)).toBe(1);
    expect(await harness.store.lookup(stale.publicKey)).toMatchObject({
      openKeys: 1,
    });
    expect((await harness.store.lookup(stale.publicKey)).tier).toBeUndefined();
    expect((await harness.store.lookup(owner.publicKey)).tier).toBe("owner");
    expect((await harness.store.lookup(fresh.publicKey)).tier).toBe("open");
    const check = new DatabaseSync(harness.dbPath);
    expect(check.prepare("SELECT count(*) AS n FROM relay_devices").get()).toEqual({ n: 0 });
    check.close();
  });
});
