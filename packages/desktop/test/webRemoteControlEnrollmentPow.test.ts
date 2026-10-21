import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { enrollmentPowHashInput, hasLeadingZeroBits } from "@zcode/shared/web-remote-relay";
import {
  createWebRemoteControlDeviceKeyBearer,
  createWebRemoteControlDeviceKeyIdentity,
} from "#src/main/web-remote-relay/index.js";
import { solveEnrollmentPow } from "#src/main/web-remote-relay/webRemoteControlEnrollmentPow.js";

const PUBLIC_KEY = "k".repeat(43);
const verifies = (publicKey: string, solved: { challenge: string; nonce: string }, bits: number) =>
  hasLeadingZeroBits(
    createHash("sha256")
      .update(enrollmentPowHashInput(publicKey, solved.challenge, solved.nonce))
      .digest(),
    bits,
  );

describe("enrollment proof of work solver", () => {
  it("finds a nonce the relay's check accepts", async () => {
    const solved = await solveEnrollmentPow({
      publicKey: PUBLIC_KEY,
      pow: { challenge: "c".repeat(34), difficulty: 12 },
    });
    expect(verifies(PUBLIC_KEY, solved, 12)).toBe(true);
  });

  it("lets timers run while it computes", async () => {
    let fired = false;
    const timer = setTimeout(() => (fired = true), 0);
    // 18 bits is ~260k hashes: many slices, so a zero-delay timer must fire before it finishes.
    const solving = solveEnrollmentPow({
      publicKey: PUBLIC_KEY,
      pow: { challenge: "d".repeat(34), difficulty: 18 },
    });
    let firedBeforeDone = false;
    void solving.then(() => (firedBeforeDone = fired));
    await solving;
    clearTimeout(timer);
    expect(firedBeforeDone).toBe(true);
  });

  it("aborts, and refuses a difficulty outside the shared bounds", async () => {
    const controller = new AbortController();
    const pending = solveEnrollmentPow({
      publicKey: PUBLIC_KEY,
      pow: { challenge: "e".repeat(34), difficulty: 32 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow("aborted");
    await expect(
      solveEnrollmentPow({
        publicKey: PUBLIC_KEY,
        pow: { challenge: "f", difficulty: 40 },
      }),
    ).rejects.toThrow("out of range");
  });
});

describe("device-key bearer with open enrollment", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const challengeResponse = (challenge: string) =>
    jsonResponse(
      {
        code: 4012,
        msg: "not enrolled",
        data: { challenge, difficulty: 10, expires_in: 60 },
      },
      401,
    );
  const okResponse = jsonResponse.bind(null, {
    code: 0,
    msg: "ok",
    data: { jwt: "relay-jwt", expires_in: 3600 },
  });
  function setup(responses: (() => Response)[], secret?: string) {
    const credentials = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
    };
    const identity = createWebRemoteControlDeviceKeyIdentity({ credentials });
    const fetcher = vi.fn(async () => responses.shift()?.() ?? okResponse());
    const bearer = createWebRemoteControlDeviceKeyBearer({
      identity,
      loadEnrollmentSecret: async () => secret,
      fetcher,
    });
    const bodyOf = (call: number) =>
      JSON.parse(String((fetcher.mock.calls[call] as unknown as [URL, RequestInit])[1].body)) as {
        device_key: { public_key: string };
        work?: { challenge: string; nonce: string };
        enrollment_secret?: string;
      };
    return { bearer, fetcher, bodyOf };
  }
  const input = () => ({
    relayOrigin: "https://relay.example.com",
    identityJwt: "ignored",
    signal: new AbortController().signal,
  });

  it("solves the relay's challenge when no secret is configured", async () => {
    const { bearer, bodyOf } = setup([() => challengeResponse("a".repeat(34)), okResponse]);
    expect(await bearer.getJwt(input())).toBe("relay-jwt");
    const second = bodyOf(1);
    expect(second).not.toHaveProperty("enrollment_secret");
    expect(verifies(second.device_key.public_key, second.work!, 10)).toBe(true);
    expect(second.work!.challenge).toBe("a".repeat(34));
  });

  it("prefers the secret over the proof of work when one is configured", async () => {
    const { bearer, bodyOf, fetcher } = setup(
      [() => challengeResponse("a".repeat(34)), okResponse],
      "s".repeat(40),
    );
    await bearer.getJwt(input());
    expect(bodyOf(1)).toMatchObject({ enrollment_secret: "s".repeat(40) });
    expect(bodyOf(1)).not.toHaveProperty("work");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries once with a fresh challenge when the solved one is refused, then gives up", async () => {
    const unauthorized = () => jsonResponse({ code: 401, msg: "unauthorized" }, 401);
    const { bearer, fetcher } = setup([
      () => challengeResponse("a".repeat(34)),
      unauthorized,
      () => challengeResponse("b".repeat(34)),
      okResponse,
    ]);
    expect(await bearer.getJwt(input())).toBe("relay-jwt");
    expect(fetcher).toHaveBeenCalledTimes(4);

    const failing = setup([
      () => challengeResponse("a".repeat(34)),
      unauthorized,
      () => challengeResponse("b".repeat(34)),
      unauthorized,
    ]);
    await expect(failing.bearer.getJwt(input())).rejects.toMatchObject({
      reason: "auth-required",
    });
  });

  it("reports relay-unavailable while the relay's breaker is open", async () => {
    const { bearer } = setup([() => jsonResponse({ code: 4503, msg: "enrollment closed" }, 503)]);
    await expect(bearer.getJwt(input())).rejects.toMatchObject({
      reason: "relay-unavailable",
    });
  });
});
