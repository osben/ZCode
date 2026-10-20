import { describe, expect, it } from "vitest";
import { RelayTokenStore } from "../src/domain/tokens.js";

function store(clock: { ms: number }, maxOutstandingPerUser?: number) {
  let counter = 0;
  return new RelayTokenStore({
    now: () => clock.ms,
    randomToken: () => `token-${(counter += 1)}`,
    maxOutstandingPerUser,
  });
}

describe("one-time WebSocket tokens", () => {
  it("is bound to the user and role and is consumed exactly once", () => {
    const clock = { ms: 0 };
    const tokens = store(clock);
    const issued = tokens.issue("user-1", "device");
    expect(issued).toEqual({ token: "token-1", expiresIn: 60 });
    expect(tokens.consume("token-1")).toEqual({
      userId: "user-1",
      role: "device",
      expiresAt: 60_000,
    });
    expect(tokens.consume("token-1")).toBeUndefined();
  });

  it("expires after 60 seconds and removes the token when it is presented late", () => {
    const clock = { ms: 0 };
    const tokens = store(clock);
    tokens.issue("user-1", "terminal");
    clock.ms = 60_000;
    expect(tokens.consume("token-1")).toBeUndefined();
    expect(tokens.consume("token-1")).toBeUndefined();
  });

  it("rejects an unknown token", () => {
    expect(store({ ms: 0 }).consume("never-issued")).toBeUndefined();
  });

  it("caps outstanding tokens per user and frees capacity after expiry or consumption", () => {
    const clock = { ms: 0 };
    const tokens = store(clock, 2);
    expect(tokens.issue("user-1", "device")).toBeDefined();
    expect(tokens.issue("user-1", "terminal")).toBeDefined();
    expect(tokens.issue("user-1", "terminal")).toBeUndefined();
    expect(tokens.issue("user-2", "device")).toBeDefined();
    tokens.consume("token-1");
    expect(tokens.issue("user-1", "terminal")).toBeDefined();
    clock.ms = 60_000;
    expect(tokens.issue("user-1", "device")).toBeDefined();
  });

  it("uses the default cap of 32 outstanding tokens per user", () => {
    const tokens = store({ ms: 0 });
    for (let index = 0; index < 32; index += 1) {
      expect(tokens.issue("user-1", "device")).toBeDefined();
    }
    expect(tokens.issue("user-1", "device")).toBeUndefined();
  });
});
