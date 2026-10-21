import { afterEach, describe, expect, it } from "vitest";
import { IdentityLimits } from "../src/domain/identityLimits.js";
import { limiterKey } from "../src/adapters/ipBucket.js";
import {
  deviceKeyBody,
  deviceKeyPair,
  ENROLLMENT_SECRET,
  solveWork,
  type DeviceKeyPair,
} from "./support/keys.js";
import { startRelay, upgradeStatus, type RelayHarness } from "./support/relayHarness.js";

const SESSION = "/api/v1/remote/session";
const TOKEN = "/api/v1/remote/token";
const cleanup: RelayHarness[] = [];
afterEach(async () => {
  for (const harness of cleanup.splice(0)) await harness.close();
});

async function quotaRelay(overrides: Parameters<typeof startRelay>[0] = {}) {
  const harness = await startRelay({
    identityMode: "device-key",
    enrollment: { mode: "open", difficulty: 8 },
    ...overrides,
  });
  cleanup.push(harness);
  return harness;
}

async function openJwt(harness: RelayHarness, pair: DeviceKeyPair = deviceKeyPair()) {
  const first = await harness.api("POST", SESSION, {
    body: deviceKeyBody(pair),
  });
  const { challenge, difficulty } = first.body.data as {
    challenge: string;
    difficulty: number;
  };
  const work = solveWork(pair.publicKey, challenge, difficulty);
  const enrolled = await harness.api("POST", SESSION, {
    body: deviceKeyBody(pair, { work }),
  });
  return (enrolled.body.data as { jwt: string }).jwt;
}

async function ownerJwt(harness: RelayHarness) {
  const result = await harness.api("POST", SESSION, {
    body: deviceKeyBody(deviceKeyPair(), { secret: ENROLLMENT_SECRET }),
  });
  return (result.body.data as { jwt: string }).jwt;
}

async function tokenUrl(harness: RelayHarness, bearer: string, role: "device" | "terminal") {
  const issued = await harness.api("POST", TOKEN, { bearer, body: { role } });
  return `${harness.server.url}?token=${encodeURIComponent((issued.body.data as { token: string }).token)}`;
}

describe("IdentityLimits", () => {
  it("scales owner limits 4x, resets bytes at the UTC day, and releases sockets once", () => {
    let ms = Date.UTC(2026, 0, 1, 23, 59, 0);
    const limits = new IdentityLimits(() => ms, {
      maxSockets: 1,
      bytesPerDay: 100,
      tokensPerMinute: 1,
    });
    expect(limits.acquireSocket("a", "open")).toBe(true);
    expect(limits.acquireSocket("a", "open")).toBe(false);
    expect(limits.acquireSocket("b", "owner")).toBe(true);
    expect(limits.acquireSocket("b", "owner")).toBe(true);
    limits.releaseSocket("a");
    limits.releaseSocket("a");
    expect(limits.acquireSocket("a", "open")).toBe(true);
    expect(limits.acquireSocket("a", "open")).toBe(false);
    expect(limits.addBytes("a", "open", 100)).toBe(true);
    expect(limits.addBytes("a", "open", 1)).toBe(false);
    expect(limits.addBytes("b", "owner", 400)).toBe(true);
    ms += 120_000;
    expect(limits.overBudget("a", "open")).toBe(false);
    expect(limits.allowToken("a", "open")).toBe(true);
    expect(limits.allowToken("a", "open")).toBe(false);
    expect(limits.allowToken("b", "owner")).toBe(true);
  });
});

describe("limiterKey", () => {
  it("buckets IPv6 by /64 across compressed and expanded spellings, and leaves IPv4 alone", () => {
    const a = limiterKey("2001:db8::1");
    expect(limiterKey("2001:0db8:0000:0000:ffff:0:0:2")).toBe(a);
    expect(limiterKey("2001:db8:0:0:1:2:3:4")).toBe(a);
    expect(limiterKey("2001:db8:0:1::1")).not.toBe(a);
    expect(limiterKey("2001:db9::1")).not.toBe(a);
    expect(limiterKey("::1")).toBe(limiterKey("0:0:0:0:5::9"));
    expect(limiterKey("fe80::1%en0")).toBe(limiterKey("fe80:0:0:0:9::"));
    expect(limiterKey("203.0.113.7")).toBe("203.0.113.7");
    expect(limiterKey("unknown")).toBe("unknown");
  });

  it("shares one anonymous limiter bucket per /64 behind a trusted proxy", async () => {
    const harness = await quotaRelay({
      trustedProxies: ["127.0.0.1"],
      registrationsPerMinute: 2,
    });
    const post = async (forwarded: string) => {
      const response = await fetch(`${harness.http}${SESSION}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": forwarded,
        },
        body: "{}",
      });
      return response.status;
    };
    expect(await post("2001:db8::1")).toBe(400);
    expect(await post("2001:db8:0:0:ffff::2")).toBe(400);
    expect(await post("2001:0db8:0:0:1:2:3:4")).toBe(429);
    expect(await post("2001:db9::1")).toBe(400);
    expect(await post("198.51.100.1")).toBe(400);
  });
});

describe("per-identity quotas", () => {
  it("rate limits POST /token per identity, with owners getting 4x", async () => {
    const harness = await quotaRelay({
      identityLimits: { tokensPerMinute: 2 },
    });
    const open = await openJwt(harness);
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push(
        (
          await harness.api("POST", TOKEN, {
            bearer: open,
            body: { role: "device" },
          })
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
    const owner = await ownerJwt(harness);
    for (let index = 0; index < 8; index += 1) {
      expect(
        (
          await harness.api("POST", TOKEN, {
            bearer: owner,
            body: { role: "device" },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await harness.api("POST", TOKEN, {
          bearer: owner,
          body: { role: "device" },
        })
      ).status,
    ).toBe(429);
  });

  it("caps registered devices per identity", async () => {
    const harness = await quotaRelay({ identityLimits: { maxDevices: 1 } });
    const open = await openJwt(harness);
    expect(
      (
        await harness.api("POST", "/api/v1/remote/device", {
          bearer: open,
          body: { device_mid: "m1" },
        })
      ).status,
    ).toBe(200);
    expect(
      await harness.api("POST", "/api/v1/remote/device", {
        bearer: open,
        body: { device_mid: "m2" },
      }),
    ).toMatchObject({
      status: 429,
      body: { code: 4029 },
    });
    const owner = await ownerJwt(harness);
    for (let index = 0; index < 4; index += 1) {
      expect(
        (
          await harness.api("POST", "/api/v1/remote/device", {
            bearer: owner,
            body: { device_mid: `o${index}` },
          })
        ).status,
      ).toBe(200);
    }
  });

  it("caps live sockets per identity, frees the slot on close, and gives owners 4x", async () => {
    const harness = await quotaRelay({ identityLimits: { maxSockets: 1 } });
    const open = await openJwt(harness);
    const first = await harness.connect(open, "device");
    expect(await upgradeStatus(await tokenUrl(harness, open, "terminal"))).toBe(429);
    first.terminate();
    await first.closed;
    expect(await upgradeStatus(await tokenUrl(harness, open, "terminal"))).toBeUndefined();

    const owner = await ownerJwt(harness);
    const sockets = [];
    for (let index = 0; index < 4; index += 1)
      sockets.push(await harness.connect(owner, "terminal"));
    expect(await upgradeStatus(await tokenUrl(harness, owner, "terminal"))).toBe(429);
    for (const socket of sockets) socket.terminate();
  });

  it("closes a socket that spends the daily inbound byte budget and refuses new tokens", async () => {
    const harness = await quotaRelay({ identityLimits: { bytesPerDay: 200 } });
    const open = await openJwt(harness);
    const socket = await harness.connect(open, "terminal");
    socket.sendRaw("x".repeat(300));
    expect(await socket.closedWith()).toBe(1013);
    expect(
      await harness.api("POST", TOKEN, {
        bearer: open,
        body: { role: "terminal" },
      }),
    ).toMatchObject({
      status: 429,
    });
  });
});

describe("pairing credentials", () => {
  const PAIRING = "/api/v1/remote/pairing";

  async function pairedJwt(harness: RelayHarness, desktop: string) {
    const code = (await harness.api("POST", PAIRING, { bearer: desktop, body: {} })).body.data as {
      code: string;
    };
    const exchanged = await harness.api("POST", SESSION, {
      body: { pairing_code: code.code },
    });
    return (exchanged.body.data as { jwt: string }).jwt;
  }
  const claimsOf = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as {
      tier?: string;
      amr?: string[];
    };

  it("refuses role device for a pairing JWT, allows terminal, and keeps the owner tier", async () => {
    const harness = await quotaRelay();
    const desktop = await ownerJwt(harness);
    const phone = await pairedJwt(harness, desktop);
    expect(claimsOf(phone)).toMatchObject({ amr: ["pairing"], tier: "owner" });
    expect(
      await harness.api("POST", TOKEN, {
        bearer: phone,
        body: { role: "device" },
      }),
    ).toMatchObject({
      status: 403,
      body: { code: 1006 },
    });
    expect(
      (
        await harness.api("POST", TOKEN, {
          bearer: phone,
          body: { role: "terminal" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.api("POST", TOKEN, {
          bearer: desktop,
          body: { role: "device" },
        })
      ).status,
    ).toBe(200);
    const openDesktop = await openJwt(harness);
    expect(claimsOf(await pairedJwt(harness, openDesktop)).tier).toBe("open");
  });

  it("closes a pairing terminal socket at JWT expiry with 4011 but leaves the device socket open", async () => {
    const harness = await quotaRelay({ ttlSeconds: 2 });
    const desktop = await ownerJwt(harness);
    const phone = await pairedJwt(harness, desktop);
    const device = await harness.connect(desktop, "device");
    const terminal = await harness.connect(phone, "terminal");
    expect(await terminal.closedWith()).toBe(4011);
    // The device socket outlives its JWT; the Desktop refreshes the JWT without reconnecting.
    expect(device.socket.readyState).toBe(device.socket.OPEN);
    device.terminate();
  });
});
