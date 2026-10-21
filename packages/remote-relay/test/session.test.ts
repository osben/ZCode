import { describe, expect, it } from "vitest";
import { createRelaySessionService } from "../src/adapters/session.js";
import {
  compactJws,
  identityKey,
  ISSUER,
  loginJwt,
  NOW_SECONDS,
  relaySigningKey,
} from "./support/keys.js";

const START_MS = NOW_SECONDS * 1000;

function service(options: {
  clock?: { ms: number };
  signing?: Record<string, unknown>[];
  identityKeys?: Record<string, unknown>[];
  audience?: string;
  userClaim?: string;
  ttlSeconds?: number;
}) {
  const clock = options.clock ?? { ms: START_MS };
  return createRelaySessionService({
    signingKeys: options.signing ?? [relaySigningKey("relay-1").privateJwk],
    ttlSeconds: options.ttlSeconds ?? 3600,
    identity: {
      issuer: ISSUER,
      ...(options.audience === undefined ? {} : { audience: options.audience }),
      userClaim: options.userClaim ?? "sub",
      keys: options.identityKeys ?? [],
    },
    now: () => clock.ms,
  });
}

function relayJwtParts(jwt: string) {
  const [header, payload] = jwt.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >,
  };
}

describe("identity exchange", () => {
  const alg = ["EdDSA", "ES256", "RS256"] as const;

  it.each(alg)(
    "accepts a login JWT signed with %s and issues a relay JWT for its subject",
    (name) => {
      const key = identityKey(name, "login-1");
      const relay = service({ identityKeys: [key.publicJwk] });
      const issued = relay.exchange(loginJwt(key, name));
      expect(issued?.expiresIn).toBe(3600);
      expect(relay.verify(issued!.jwt)).toBe("user-1");
    },
  );

  it("rejects the none algorithm and HMAC algorithms", () => {
    const key = identityKey("EdDSA", "login-1");
    const relay = service({ identityKeys: [key.publicJwk] });
    const now = START_MS / 1000;
    const claims = { iss: ISSUER, sub: "user-1", exp: now + 600 };
    expect(
      relay.exchange(compactJws({ alg: "none", kid: "login-1" }, claims, undefined, "none")),
    ).toBeUndefined();
    expect(
      relay.exchange(compactJws({ alg: "HS256", kid: "login-1" }, claims, undefined, "HS256")),
    ).toBeUndefined();
  });

  it("rejects an expired login JWT beyond the 30 second skew", () => {
    const key = identityKey("EdDSA", "login-1");
    const relay = service({ identityKeys: [key.publicJwk] });
    const now = START_MS / 1000;
    expect(relay.exchange(loginJwt(key, "EdDSA", { exp: now - 31 }, now))).toBeUndefined();
    expect(relay.exchange(loginJwt(key, "EdDSA", { exp: now - 10 }, now))).toBeDefined();
  });

  it("rejects a foreign issuer, a wrong audience, and a missing or empty user claim", () => {
    const key = identityKey("EdDSA", "login-1");
    const relay = service({
      identityKeys: [key.publicJwk],
      audience: "fixture-audience",
    });
    const now = START_MS / 1000;
    expect(
      relay.exchange(
        loginJwt(key, "EdDSA", { iss: "https://other.invalid", aud: "fixture-audience" }, now),
      ),
    ).toBeUndefined();
    expect(relay.exchange(loginJwt(key, "EdDSA", { aud: "someone-else" }, now))).toBeUndefined();
    expect(
      relay.exchange(loginJwt(key, "EdDSA", { aud: "fixture-audience", sub: "" }, now)),
    ).toBeUndefined();
    expect(
      relay.exchange(loginJwt(key, "EdDSA", { aud: "fixture-audience", sub: undefined }, now)),
    ).toBeUndefined();
  });

  it("selects the identity key by kid and rejects an unknown kid", () => {
    const key = identityKey("EdDSA", "login-1");
    const relay = service({ identityKeys: [key.publicJwk] });
    const other = identityKey("EdDSA", "login-2");
    expect(relay.exchange(loginJwt(other, "EdDSA", {}, START_MS / 1000))).toBeUndefined();
  });

  it("accepts a token without kid only when the identity set holds exactly one key", () => {
    const key = identityKey("EdDSA", "login-1");
    const single = service({ identityKeys: [key.publicJwk] });
    const now = START_MS / 1000;
    const claims = { iss: ISSUER, sub: "user-1", exp: now + 600 };
    expect(
      single.exchange(compactJws({ alg: "EdDSA" }, claims, key.privateKey, "EdDSA")),
    ).toBeDefined();
    const other = identityKey("EdDSA", "login-2");
    const pair = service({ identityKeys: [key.publicJwk, other.publicJwk] });
    expect(
      pair.exchange(compactJws({ alg: "EdDSA" }, claims, key.privateKey, "EdDSA")),
    ).toBeUndefined();
  });

  it("uses the configured user claim", () => {
    const key = identityKey("EdDSA", "login-1");
    const relay = service({ identityKeys: [key.publicJwk], userClaim: "uid" });
    const issued = relay.exchange(loginJwt(key, "EdDSA", { sub: undefined, uid: "user-42" }));
    expect(relay.verify(issued!.jwt)).toBe("user-42");
  });

  it("refuses private material in the identity set", () => {
    const key = identityKey("EdDSA", "login-1");
    expect(() => service({ identityKeys: [{ ...key.publicJwk, d: "AAAA" }] })).toThrow(
      /must be public/,
    );
  });
});

describe("relay JWT", () => {
  it("issues EdDSA tokens with the fixed issuer, audience, subject and TTL", () => {
    const key = identityKey("EdDSA", "login-1");
    const relay = service({ identityKeys: [key.publicJwk] });
    const issued = relay.exchange(loginJwt(key, "EdDSA"));
    const { header, payload } = relayJwtParts(issued!.jwt);
    expect(header).toMatchObject({ alg: "EdDSA", typ: "JWT", kid: "relay-1" });
    expect(payload).toMatchObject({
      iss: "zcode-remote-relay",
      aud: "zcode-remote-relay",
      sub: "user-1",
      exp: (payload.iat as number) + 3600,
    });
  });

  it("rejects a relay JWT after its expiry", () => {
    const clock = { ms: START_MS };
    const key = identityKey("EdDSA", "login-1");
    const relay = service({
      clock,
      identityKeys: [key.publicJwk],
      ttlSeconds: 60,
    });
    const issued = relay.exchange(loginJwt(key, "EdDSA", {}, START_MS / 1000));
    expect(relay.verify(issued!.jwt)).toBe("user-1");
    clock.ms += 61_000;
    expect(relay.verify(issued!.jwt)).toBeUndefined();
  });

  it("rejects a tampered payload and a token signed by an unknown relay key", () => {
    const key = identityKey("EdDSA", "login-1");
    const relay = service({ identityKeys: [key.publicJwk] });
    const issued = relay.exchange(loginJwt(key, "EdDSA"))!.jwt;
    const [header, , signature] = issued.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        iss: "zcode-remote-relay",
        aud: "zcode-remote-relay",
        sub: "admin",
        iat: START_MS / 1000,
        exp: START_MS / 1000 + 600,
      }),
    ).toString("base64url");
    expect(relay.verify(`${header}.${forged}.${signature}`)).toBeUndefined();
    const stranger = service({
      signing: [relaySigningKey("relay-9").privateJwk],
      identityKeys: [key.publicJwk],
    });
    expect(relay.verify(stranger.exchange(loginJwt(key, "EdDSA"))!.jwt)).toBeUndefined();
  });

  it("rotates keys: the first entry signs, older entries still verify, removed kids are rejected", () => {
    const key = identityKey("EdDSA", "login-1");
    const oldKey = relaySigningKey("relay-old").privateJwk;
    const newKey = relaySigningKey("relay-new").privateJwk;
    const before = service({
      signing: [oldKey],
      identityKeys: [key.publicJwk],
    });
    const oldToken = before.exchange(loginJwt(key, "EdDSA"))!.jwt;

    const during = service({
      signing: [newKey, oldKey],
      identityKeys: [key.publicJwk],
    });
    const newToken = during.exchange(loginJwt(key, "EdDSA"))!.jwt;
    expect(relayJwtParts(newToken).header.kid).toBe("relay-new");
    expect(during.verify(oldToken)).toBe("user-1");
    expect(during.verify(newToken)).toBe("user-1");

    const after = service({ signing: [newKey], identityKeys: [key.publicJwk] });
    expect(after.verify(oldToken)).toBeUndefined();
    expect(after.verify(newToken)).toBe("user-1");
  });

  it("refuses duplicate kids, non-Ed25519 signing keys and an out-of-range TTL", () => {
    const key = identityKey("EdDSA", "login-1");
    const dup = relaySigningKey("same").privateJwk;
    expect(() => service({ signing: [dup, dup], identityKeys: [key.publicJwk] })).toThrow(/unique/);
    expect(() =>
      service({
        signing: [{ kty: "EC", crv: "P-256", kid: "x" }],
        identityKeys: [key.publicJwk],
      }),
    ).toThrow();
    expect(() => service({ identityKeys: [key.publicJwk], ttlSeconds: 86_401 })).toThrow(/TTL/);
    expect(() => service({ identityKeys: [key.publicJwk], ttlSeconds: 0 })).toThrow(/TTL/);
  });
});
