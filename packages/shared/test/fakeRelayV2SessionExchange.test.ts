import { afterEach, expect, it } from "vitest";
import { createFakeRelayV2 } from "./fixtures/fake-relay-v2.js";

let relay: Awaited<ReturnType<typeof createFakeRelayV2>> | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function exchange(identityToken: unknown) {
  const response = await fetch(new URL("/api/v1/remote/session", relay!.httpUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity_token: identityToken }),
  });
  return { status: response.status, body: await response.json() };
}

it("exchanges a known identity token for a relay JWT that the other routes accept", async () => {
  relay = await createFakeRelayV2({ users: { "identity-a": "user-a" } });
  const session = await exchange("identity-a");
  expect(session.status).toBe(200);
  expect(session.body.code).toBe(0);
  expect(session.body.data.expires_in).toBeGreaterThan(0);
  const devices = await fetch(new URL("/api/v1/remote/device", relay.httpUrl), {
    headers: { Authorization: `Bearer ${session.body.data.jwt}` },
  });
  expect(devices.status).toBe(200);
  expect(relay.httpCalls.at(-1)?.userId).toBe("user-a");
});

it("rejects an unknown identity token", async () => {
  relay = await createFakeRelayV2({ users: { "identity-a": "user-a" } });
  expect((await exchange("someone-else")).status).toBe(401);
  expect((await exchange(undefined)).status).toBe(401);
});
