import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

type Jwk = Record<string, unknown>;

export const ISSUER = "https://identity.fixture.invalid";
export const AUDIENCE = "fixture-audience";
/** Fixed clock for token claims: tests pass the same instant to the relay and to the tokens they build. */
export const NOW_SECONDS = 1_800_000_000;

/** Ed25519 pair for relay JWT signing: the private JWK goes to the relay config, never to clients. */
export function relaySigningKey(kid: string) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateJwk: { ...privateKey.export({ format: "jwk" }), kid } as Jwk };
}

/** A login-identity key pair of the given algorithm family. The public JWK is what the relay trusts. */
export function identityKey(alg: "EdDSA" | "ES256" | "RS256", kid: string) {
  const pair =
    alg === "EdDSA"
      ? generateKeyPairSync("ed25519")
      : alg === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...pair.publicKey.export({ format: "jwk" }), kid } as Jwk,
  };
}

/** Signs a compact JWS with an arbitrary header, so tests can build malformed or forged tokens. */
export function compactJws(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: KeyObject | undefined,
  alg: string,
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  let signature = "";
  if (key && alg === "EdDSA")
    signature = sign(null, Buffer.from(signingInput), key).toString("base64url");
  if (key && alg === "ES256") {
    signature = sign("sha256", Buffer.from(signingInput), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  }
  if (key && alg === "RS256")
    signature = sign("sha256", Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** A valid login JWT for the fixture issuer, signed with the given identity key. */
export function loginJwt(
  key: { privateKey: KeyObject; publicJwk: Jwk },
  alg: "EdDSA" | "ES256" | "RS256",
  overrides: Record<string, unknown> = {},
  now = NOW_SECONDS,
): string {
  const kid = key.publicJwk.kid as string;
  return compactJws(
    { alg, typ: "JWT", kid },
    { iss: ISSUER, sub: "user-1", iat: now, exp: now + 600, ...overrides },
    key.privateKey,
    alg,
  );
}
