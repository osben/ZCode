// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOAuthCredentialRepo } from "../src/auth/browserOAuthCredentialRepo.js";

const NOW = 1_800_000_000_000;

function memoryStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

function jwt(expSeconds: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ exp: expSeconds })}.signature`;
}

function snapshot(storage: Storage): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) result[key] = storage.getItem(key);
  }
  return result;
}

// Upstream 3.18.0 keeps the cached-session read free of side effects: clearing storage on an
// expired legacy JWT also wiped a login the user had started in another tab.
describe("web cached session read", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an expired legacy JWT without clearing any stored credential", () => {
    const storage = memoryStorage({
      "oauth:active_provider": "zai",
      zcodejwttoken: jwt(NOW / 1000 - 60),
      "oauth:zai:access_token": "access",
      "oauth:zai:user_info": JSON.stringify({ id: "user-1", name: "User" }),
      oauth_pending_logins: JSON.stringify([]),
      "oauth:browser_login_attempt": "attempt-1",
    });
    const before = snapshot(storage);
    const repo = new BrowserOAuthCredentialRepo({ localStorage: storage }, { now: () => NOW });

    expect(repo.loadCachedSessionState()).toEqual({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    expect(snapshot(storage)).toEqual(before);
  });
});
