import { expect, it } from "vitest";
import { relayExample } from "./contract.example.js";

it("composes an explicitly supplied store and session service without workspace services", () => {
  const store = {
    register: async () => ({
      deviceSid: "fixture",
      userId: "user",
      deviceMid: "mid",
      createdAt: 0,
    }),
    listForUser: async () => [],
    get: async () => undefined,
    remove: async () => false,
    close: async () => {},
  };
  const session = {
    mode: "zai-jwt" as const,
    exchange: () => undefined,
    exchangeDeviceKey: async () => ({ status: "denied" as const }),
    exchangePairing: () => undefined,
    createPairing: () => undefined,
    claims: () => undefined,
    verify: () => undefined,
  };
  expect(relayExample(store, session)).toEqual({
    store,
    session,
    host: "127.0.0.1",
    port: 0,
  });
});
