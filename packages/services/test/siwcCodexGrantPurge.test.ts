import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICredentialService } from "../src/credential/credential.js";
import { SiwcCodexGrantPurge } from "../src/oauth/siwc/siwcCodexGrantPurge.js";

// specs/chatgpt-plan-signin.md "Usage limits → Leftover grant purge".
const ACCOUNT_KEY = "a1b2c3d4e5f60718";
const KEYS = [
  `oauth:chatgpt-codex:${ACCOUNT_KEY}:access_token`,
  `oauth:chatgpt-codex:${ACCOUNT_KEY}:refresh_token`,
  `oauth:chatgpt-codex:${ACCOUNT_KEY}:id_token`,
  `oauth:chatgpt-codex:${ACCOUNT_KEY}:account_id`,
  `oauth:chatgpt-codex:${ACCOUNT_KEY}:access_expires_at`,
  `fork:oauth:chatgpt:${ACCOUNT_KEY}:usage-epoch`,
];
const tempDirs: string[] = [];

function memoryCredentials(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const service = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  } as unknown as ICredentialService;
  return { service, values };
}

async function createPurge(initial: Record<string, string>, fetchFn: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), "siwc-codex-purge-"));
  tempDirs.push(dir);
  const credentials = memoryCredentials(initial);
  return { ...credentials, purge: new SiwcCodexGrantPurge(credentials.service, dir, fetchFn) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SiwcCodexGrantPurge", () => {
  it("revokes the stored refresh token, then deletes every leftover key", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const { purge, values } = await createPurge(
      { ...Object.fromEntries(KEYS.map((key) => [key, "v"])), other: "keep" },
      fetchFn as unknown as typeof fetch,
    );
    values.set(KEYS[1]!, "old-refresh");

    await purge.purgeAccount(ACCOUNT_KEY);

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/revoke");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("token")).toBe("old-refresh");
    expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect([...values.keys()]).toEqual(["other"]);
  });

  it("deletes locally when the revoke fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    const { purge, values } = await createPurge(
      { [KEYS[1]!]: "old-refresh", [KEYS[5]!]: "epoch" },
      fetchFn as unknown as typeof fetch,
    );
    await purge.purgeAccount(ACCOUNT_KEY);
    expect(values.size).toBe(0);
  });

  it("makes no request when nothing is stored or the key is malformed", async () => {
    const fetchFn = vi.fn();
    const { purge } = await createPurge({}, fetchFn as unknown as typeof fetch);
    await purge.purgeAccount(ACCOUNT_KEY);
    await purge.purgeAccount("not-a-key");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
