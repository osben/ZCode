import type { ApiClient } from "@zcode/shared";
import { ZAI_CN_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICredentialService } from "../src/credential/credential.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";
import { buildDesktopOAuthRedirectUriFromEnv } from "../src/oauth/providers/configUtils.js";

const NOW = 1_700_000_000_000;
const STATE = "state-1";
const ENV: NodeJS.ProcessEnv = {};

function createMemoryCredentialService(): ICredentialService {
  const stored = new Map<string, string | null>();
  const read = (key: string) => (stored.has(key) ? (stored.get(key) ?? null) : null);
  return {
    inspectStore: async () => ({ status: "healthy" as const }),
    recoverStore: async () => ({ status: "changed" as const }),
    load: async (key: string) => read(key),
    save: async (key: string, value: string) => {
      stored.set(key, value);
    },
    delete: async (key: string) => {
      stored.set(key, null);
    },
    loadMany: async (keys: readonly string[]) =>
      Object.fromEntries(keys.map((key) => [key, read(key)])),
    updateMany: async (changes: Readonly<Record<string, string | null>>) => {
      for (const [key, value] of Object.entries(changes)) stored.set(key, value);
      return true;
    },
    deleteUnreadable: async () => false,
  } as unknown as ICredentialService;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as Response;
}

/**
 * Only the polling init is answered; any other request (token exchange, profile, poll) fails the test,
 * so a callback that wrongly exchanges the code surfaces as a rejected request.
 */
function createApiClient() {
  const request = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/v1/oauth/cli/init")) {
      return jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-1",
          authorize_url: `https://chat.z.ai/api/oauth/authorize?state=${STATE}`,
          expires_at: NOW / 1000 + 600,
          poll_interval_sec: 2,
        },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return { client: { request } as unknown as ApiClient, request };
}

function createService(apiClient: ApiClient) {
  return new OAuthService(createMemoryCredentialService(), {
    apiClient,
    env: ENV,
    now: () => NOW,
  });
}

/** Internal hooks used to reproduce the interleavings; the public API has no way to hold the session queue. */
type Internals = {
  runSessionMutation<T>(run: () => Promise<T>): Promise<T>;
  pendingState: unknown;
  oauthFlowStartGeneration: number;
  recentlyCompletedPollingState: unknown;
  clearPendingState(): void;
};

const CALLBACK_URL = `https://relay.example.com/app/oauth/callback?state=${STATE}&code=auth-code&utm_source=campaign`;

describe("zai polling authorize URL", () => {
  it("routes zai_cn through the relay and tags the relay URL with the provider", async () => {
    const { client } = createApiClient();
    const service = createService(client);

    const start = await service.startOAuthWithPolling(ZAI_CN_PROVIDER_ID);

    const redirectUri = new URL(start.authorizeUrl).searchParams.get("redirect_uri");
    const expectedRelay = new URL(buildDesktopOAuthRedirectUriFromEnv(ENV));
    expectedRelay.searchParams.set("provider", ZAI_CN_PROVIDER_ID);
    expect(redirectUri).toBe(expectedRelay.toString());
  });

  it("routes zai through the relay without the provider hint", async () => {
    const { client } = createApiClient();
    const service = createService(client);

    const start = await service.startOAuthWithPolling(ZAI_PROVIDER_ID);

    expect(new URL(start.authorizeUrl).searchParams.get("redirect_uri")).toBe(
      new URL(buildDesktopOAuthRedirectUriFromEnv(ENV)).toString(),
    );
    expect(new URL(start.authorizeUrl).searchParams.get("redirect_uri")).not.toContain("provider=");
  });
});

describe("zai_cn polling callback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves attribution but never exchanges the code while polling owns completion", async () => {
    const { client, request } = createApiClient();
    const service = createService(client);
    const saveAttribution = vi
      .spyOn(OAuthCredentialRepo.prototype, "saveLoginAttribution")
      .mockResolvedValue(undefined);
    await service.startOAuthWithPolling(ZAI_CN_PROVIDER_ID);

    await expect(service.handleCallback(CALLBACK_URL)).resolves.toBeNull();

    expect(saveAttribution).toHaveBeenCalledTimes(1);
    expect(saveAttribution).toHaveBeenCalledWith({ utm_source: "campaign" });
    // Only the init request: no token exchange or profile request was issued from the callback.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("still saves attribution when polling completed while the callback waited for the session queue", async () => {
    const { client, request } = createApiClient();
    const service = createService(client);
    const internals = service as unknown as Internals;
    const saveAttribution = vi
      .spyOn(OAuthCredentialRepo.prototype, "saveLoginAttribution")
      .mockResolvedValue(undefined);
    await service.startOAuthWithPolling(ZAI_CN_PROVIDER_ID);
    const pending = internals.pendingState as { provider: string; state: string };

    // Hold the session queue so the callback is admitted with a pending flow, then polling completes before it runs.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const gate = internals.runSessionMutation(() => released);
    const callback = service.handleCallback(CALLBACK_URL);
    internals.clearPendingState();
    internals.recentlyCompletedPollingState = {
      generation: internals.oauthFlowStartGeneration,
      expiresAt: NOW + 30_000,
      provider: pending.provider,
      state: pending.state,
    };
    release();
    await gate;

    await expect(callback).resolves.toBeNull();
    expect(saveAttribution).toHaveBeenCalledWith({ utm_source: "campaign" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("drops attribution when a newer login replaced the flow while the callback waited", async () => {
    const { client } = createApiClient();
    const service = createService(client);
    const internals = service as unknown as Internals;
    const saveAttribution = vi
      .spyOn(OAuthCredentialRepo.prototype, "saveLoginAttribution")
      .mockResolvedValue(undefined);
    await service.startOAuthWithPolling(ZAI_CN_PROVIDER_ID);

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const gate = internals.runSessionMutation(() => released);
    // cancelPending bumps the flow generation and clears pending state, as a newer login would. It is queued before the
    // callback so the callback's pending capture still succeeds while its queued write sees the new generation.
    const cancel = service.cancelPending(ZAI_CN_PROVIDER_ID);
    const callback = service.handleCallback(CALLBACK_URL);
    release();
    await gate;

    await cancel;
    await expect(callback).resolves.toBeNull();
    expect(saveAttribution).not.toHaveBeenCalled();
  });
});
