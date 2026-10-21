import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createWebRemoteControlDeviceKeyBearer,
  createWebRemoteControlDeviceKeyIdentity,
  WEB_REMOTE_CONTROL_DEVICE_KEY_CREDENTIAL,
} from "#src/main/web-remote-relay/index.js";

const SECRET = "enrollment-secret-fixture-0123456789abcdef";

function credentialStore(delayMs = 0) {
  const values = new Map<string, string>();
  return {
    values,
    load: vi.fn(async (key: string) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return values.get(key);
    }),
    save: vi.fn(async (key: string, value: string) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      values.set(key, value);
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = (jwt: string, expiresIn = 3600) =>
  jsonResponse({ code: 0, msg: "ok", data: { jwt, expires_in: expiresIn } });

describe("device-key identity", () => {
  it("generates one key under concurrent first use and persists it under the fork_ credential", async () => {
    const credentials = credentialStore(5);
    const identity = createWebRemoteControlDeviceKeyIdentity({ credentials });
    const [a, b, c] = await Promise.all([identity.userId(), identity.userId(), identity.userId()]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(credentials.save).toHaveBeenCalledTimes(1);
    expect(WEB_REMOTE_CONTROL_DEVICE_KEY_CREDENTIAL.startsWith("fork_")).toBe(true);
    expect([...credentials.values.keys()]).toEqual([WEB_REMOTE_CONTROL_DEVICE_KEY_CREDENTIAL]);
    // A second identity over the same store reuses the key.
    expect(await createWebRemoteControlDeviceKeyIdentity({ credentials }).userId()).toBe(a);
  });

  it("derives the dk: user id from the raw public key and signs the documented challenge", async () => {
    const credentials = credentialStore();
    let tick = 1_800_000_000_000;
    const identity = createWebRemoteControlDeviceKeyIdentity({
      credentials,
      now: () => tick,
      randomNonce: () => "n".repeat(22),
    });
    const proof = await identity.proveExchange();
    expect(proof).toMatchObject({ ts: 1_800_000_000, nonce: "n".repeat(22) });
    expect(proof.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await identity.userId()).toBe(
      `dk:${createHash("sha256").update(Buffer.from(proof.publicKey, "base64url")).digest("base64url")}`,
    );
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: proof.publicKey },
      format: "jwk",
    });
    const signed = `zcode-relay-device-session-v1\nzcode-remote-relay\n${proof.publicKey}\n${proof.ts}\n${proof.nonce}`;
    expect(verify(null, Buffer.from(signed), key, Buffer.from(proof.signature, "base64url"))).toBe(
      true,
    );
    tick += 1000;
  });

  it("treats an unreadable stored key as fatal instead of silently replacing the identity", async () => {
    const credentials = credentialStore();
    credentials.values.set(WEB_REMOTE_CONTROL_DEVICE_KEY_CREDENTIAL, "not json");
    const identity = createWebRemoteControlDeviceKeyIdentity({ credentials });
    await expect(identity.userId()).rejects.toThrow();
    expect(credentials.save).not.toHaveBeenCalled();
  });
});

describe("device-key relay bearer", () => {
  function setup(responses: Response[], secret: string | null = SECRET) {
    const credentials = credentialStore();
    const identity = createWebRemoteControlDeviceKeyIdentity({ credentials });
    const fetcher = vi.fn(async () => responses.shift() ?? ok("extra"));
    let tick = 1_000_000;
    const bearer = createWebRemoteControlDeviceKeyBearer({
      identity,
      loadEnrollmentSecret: async () => secret ?? undefined,
      fetcher,
      now: () => tick,
    });
    return { bearer, fetcher, advance: (ms: number) => (tick += ms) };
  }
  const input = () => ({
    relayOrigin: "https://relay.example.com",
    identityJwt: "ignored-placeholder",
    signal: new AbortController().signal,
  });
  const bodyOf = (fetcher: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse(
      String((fetcher.mock.calls[call] as unknown as [URL, RequestInit])[1].body),
    ) as Record<string, unknown>;

  it("enrolls only after the relay answers 4012, then sends no secret", async () => {
    const { bearer, fetcher, advance } = setup([
      jsonResponse({ code: 4012, msg: "not enrolled" }, 401),
      ok("relay-1", 100),
      ok("relay-2", 100),
    ]);
    expect(await bearer.getJwt(input())).toBe("relay-1");
    expect(bodyOf(fetcher, 0)).not.toHaveProperty("enrollment_secret");
    expect(bodyOf(fetcher, 1)).toMatchObject({ enrollment_secret: SECRET });
    expect(bodyOf(fetcher, 1).device_key).not.toEqual(bodyOf(fetcher, 0).device_key);
    advance(200_000);
    expect(await bearer.getJwt(input())).toBe("relay-2");
    expect(bodyOf(fetcher, 2)).not.toHaveProperty("enrollment_secret");
  });

  it("reports auth-required when the relay wants enrollment but no secret is configured", async () => {
    const { bearer } = setup([jsonResponse({ code: 4012, msg: "not enrolled" }, 401)], null);
    await expect(bearer.getJwt(input())).rejects.toMatchObject({ reason: "auth-required" });
  });

  it("reuses the cached JWT and refetches after invalidate()", async () => {
    const { bearer, fetcher } = setup([ok("relay-1"), ok("relay-2")]);
    expect(await bearer.getJwt(input())).toBe("relay-1");
    expect(await bearer.getJwt(input())).toBe("relay-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    bearer.invalidate();
    expect(await bearer.getJwt(input())).toBe("relay-2");
  });

  it("issues a pairing code with the relay JWT and returns undefined when the relay refuses", async () => {
    const { bearer, fetcher } = setup([
      ok("relay-1"),
      jsonResponse({ code: 0, msg: "ok", data: { code: "p".repeat(22), expires_in: 300 } }),
      jsonResponse({ code: 404, msg: "not found" }, 404),
    ]);
    const code = await bearer.issuePairingCode({
      relayOrigin: "https://relay.example.com",
      signal: new AbortController().signal,
    });
    expect(code).toBe("p".repeat(22));
    const [url, init] = fetcher.mock.calls[1] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://relay.example.com/api/v1/remote/pairing");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer relay-1");
    expect(
      await bearer.issuePairingCode({
        relayOrigin: "https://relay.example.com",
        signal: new AbortController().signal,
      }),
    ).toBeUndefined();
  });
});
