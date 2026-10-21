import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRelayV2, type FakeRelayV2Options } from "@zcode/shared/testing/fake-relay-v2";
import {
  buildZCodeEndpointUrls,
  type AppSettings,
  type WebRemoteControlContext,
} from "@zcode/shared";
import {
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
} from "@zcode/shared/web-remote-relay";
import { createWebRemoteControlManager } from "@desktop/main/webRemoteControlManager.js";
import { createWebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/index.js";
import { createWebRemoteControlFeatureGate } from "@desktop/main/webRemoteControlFeatureGate.js";
import { createOAuthService } from "@zcode/services/node";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.useRealTimers();
});

async function fixture(
  options: Partial<FakeRelayV2Options> = {},
  initialSettings: Partial<AppSettings> = {},
  deviceSaveError?: Error,
  pairing?: { issueCode: (input: { relayOrigin: string }) => Promise<string | undefined> },
  accountAuthIndependent = false,
) {
  const relay = await createFakeRelayV2({
    users: { jwt: "user", other: "other-user" },
    ...options,
  });
  cleanups.push(() => relay.close());
  const settings: AppSettings = {
    recentProjects: [],
    webRemoteControlExternalRelayDevice: { deviceSid: "v1-sid" },
    ...initialSettings,
  };
  const credentials = new Map([["web-remote-control:external-relay:pass_hash", "v1-hash"]]);
  let login: { jwt: string; userId: string } | undefined = { jwt: "jwt", userId: "user" };
  let endpoint = relay.httpUrl;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deviceStorage = createWebRemoteControlDeviceStorage({
    loadSettings: async () => settings,
    patchSettings: async (patch) => {
      if (deviceSaveError && Object.hasOwn(patch, "webRemoteControlRelayV2Device")) {
        throw deviceSaveError;
      }
      Object.assign(settings, patch);
    },
    deleteLegacyCredential: async () => {
      credentials.delete("web-remote-control:external-relay:pass_hash");
    },
  });
  const readLogin = vi.fn(async () => login);
  const loadEnabled = vi.fn(async () => settings.webRemoteControlLastEnabledContext);
  const attachWorkspaceHost = vi.fn(async () => {
    throw new Error("No bridge expected");
  });
  const manager = createWebRemoteControlManager({
    relayWsUrl: relay.wsUrl,
    mobileRemoteControlUrl: `${relay.httpUrl}/remote/v4`,
    getEndpointUrls: () => ({
      ...buildZCodeEndpointUrls(endpoint, { appVersion: "3.13.0" }),
      relayWsUrl: endpoint.replace("http", "ws") + "/api/v1/remote/ws2",
    }),
    getLogin: readLogin,
    ...(pairing === undefined ? {} : { pairing }),
    ...(accountAuthIndependent ? { accountAuthIndependent } : {}),
    deviceStorage,
    deviceMid: "desktop-mid",
    deviceName: "Desktop name",
    appVersion: "3.13.0",
    logger,
    featureGate: createWebRemoteControlFeatureGate(true),
    startupRestoreStorageProvider: {
      load: loadEnabled,
      save: async (context) => {
        settings.webRemoteControlLastEnabledContext = context;
      },
      clear: async () => {
        settings.webRemoteControlLastEnabledContext = undefined;
      },
    },
    platformHandlers: {
      isDockerAvailable: async () => false,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    },
    reconnectWorkspace: async () => {},
    attachWorkspaceHost,
    releaseWorkspaceHostAttachment: () => {},
    disposeWorkspaceHostAttachmentsForWindow: () => {},
    disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
  });
  cleanups.push(async () => {
    await manager.suspend(1, "test-cleanup");
    await manager.suspend(2, "test-cleanup");
  });
  const context = { workspacePath: "/workspace" };
  const start = (target: WebRemoteControlContext = context) =>
    manager.startAuthorized(1, target, manager.authorizeStart(1, target));
  return {
    manager,
    start,
    settings,
    credentials,
    relay,
    logger,
    readLogin,
    loadEnabled,
    attachWorkspaceHost,
    setLogin: (value: typeof login) => {
      login = value;
    },
    setEndpoint: (value: string) => {
      endpoint = value;
    },
  };
}

async function connectTerminal(
  relay: Awaited<ReturnType<typeof createFakeRelayV2>>,
  jwt: string,
  deviceSid: string,
) {
  const response = await fetch(`${relay.httpUrl}/api/v1/remote/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "terminal" }),
  });
  const { data } = await response.json();
  const socket = new WebSocket(`${relay.wsUrl}?token=${data.token}`);
  cleanups.push(() => socket.close());
  const messages: WebRemoteControlRelayV2IncomingMessage[] = [];
  socket.on("message", (raw) => {
    const message = parseWebRemoteControlRelayV2IncomingMessage(JSON.parse(raw.toString()));
    if (message) messages.push(message);
  });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "auth_init", device_sid: deviceSid }));
  await vi.waitFor(() =>
    expect(messages.some((message) => message.type === "auth_ack")).toBe(true),
  );
  return { socket, messages };
}

function requestBootstrap(socket: WebSocket) {
  socket.send(
    JSON.stringify({
      type: "data",
      payload: { zcode_type: "bootstrap-request", requestId: "account-isolation" },
    }),
  );
}

describe("V2 manager public API with real relay", () => {
  it.each([false, true])(
    "identity save failure deletes the new device and stops re-registration immediately (existing invalid SID: %s)",
    async (invalidStoredSid) => {
      const saveError = Object.assign(new Error("device settings write failed"), {
        code: "ENOSPC",
      });
      const f = await fixture({}, {}, saveError);
      const headers = { Authorization: "Bearer jwt", "Content-Type": "application/json" };
      if (invalidStoredSid) {
        const response = await fetch(`${f.relay.httpUrl}/api/v1/remote/device`, {
          method: "POST",
          headers,
          body: JSON.stringify({ device_mid: "desktop-mid" }),
        });
        const { data } = await response.json();
        f.settings.webRemoteControlRelayV2Device = {
          deviceSid: data.device_sid,
          userId: "user",
          endpointOrigin: f.relay.httpUrl,
        };
        await fetch(`${f.relay.httpUrl}/api/v1/remote/device/delete`, {
          method: "POST",
          headers,
          body: JSON.stringify({ device_sid: data.device_sid }),
        });
      }
      const stored = f.settings.webRemoteControlRelayV2Device;
      const previousCalls = f.relay.httpCalls.length;
      const started = f.start().catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(f.manager.getStatus(1)).toMatchObject({
          status: "error",
          failure: { reason: "relay-unavailable" },
        }),
      );
      expect(await started).toMatchObject({ reason: "relay-unavailable", retryable: false });
      const devices = await (
        await fetch(`${f.relay.httpUrl}/api/v1/remote/device`, { headers })
      ).json();
      expect(devices.data).toEqual([]);
      // Covers the first network backoff window and proves the terminal state never creates another remote device.
      await delay(2500);
      expect(
        f.relay.httpCalls
          .slice(previousCalls)
          .filter((call) => call.path === "/api/v1/remote/device" && call.method === "POST"),
      ).toHaveLength(1);
      expect(f.settings.webRemoteControlRelayV2Device).toEqual(stored);
      expect(f.settings.webRemoteControlLastEnabledContext).toBeUndefined();
      expect(f.logger.error).toHaveBeenCalledWith(
        "[web-remote-control] V2 device identity persistence failed",
        saveError,
      );
    },
  );

  it("compensating delete after a save failure that returns 503 still ends startup without accumulating orphan devices", async () => {
    const saveError = Object.assign(new Error("device settings write failed"), { code: "ENOSPC" });
    const f = await fixture(
      { onHttp: (call) => (call.path.endsWith("/delete") ? { status: 503 } : undefined) },
      {},
      saveError,
    );
    await expect(f.start()).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: false,
    });
    expect(f.manager.getStatus(1)).toMatchObject({ status: "error" });
    expect(f.logger.warn).toHaveBeenCalledWith("[web-remote-control] V2 new device cleanup failed");
    await delay(2500);
    const devices = await (
      await fetch(`${f.relay.httpUrl}/api/v1/remote/device`, {
        headers: { Authorization: "Bearer jwt" },
      })
    ).json();
    expect(devices.data).toHaveLength(1);
    expect(devices.data[0].online).toBe(false);
    expect(
      f.relay.httpCalls.filter(
        (call) => call.path === "/api/v1/remote/device" && call.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("a provider cleanup failure after the credential is cleared still revokes the pairing connection and keeps the enablement record", async () => {
    const f = await fixture();
    const credentials = new Map([
      ["oauth:active_provider", "zai"],
      [
        "oauth:zai:user_info",
        JSON.stringify({ id: "user", username: "User", displayName: "User" }),
      ],
      ["oauth:zai:access_token", "access"],
      ["zcodejwttoken", "jwt"],
    ]);
    f.readLogin.mockImplementation(async () =>
      credentials.has("zcodejwttoken") ? { jwt: "jwt", userId: "user" } : undefined,
    );
    const oauth = createOAuthService(
      {
        load: async (key) => credentials.get(key) ?? null,
        save: async (key, value) => {
          credentials.set(key, value);
        },
        delete: async (key) => {
          credentials.delete(key);
        },
      },
      {
        apiClient: { request: vi.fn<typeof fetch>() },
        onProviderLogout: async () => {
          throw new Error("derived settings failed");
        },
      },
    );
    const subscription = oauth.onDidChangeSession((state) => {
      void f.manager.notifyAuthStateChanged(1, { state });
    });
    cleanups.push(() => subscription.dispose());
    await f.start();
    const sid = f.settings.webRemoteControlRelayV2Device!.deviceSid;
    const terminal = await connectTerminal(f.relay, "jwt", sid);
    requestBootstrap(terminal.socket);
    await vi.waitFor(() =>
      expect(terminal.messages.some((message) => message.type === "data")).toBe(true),
    );
    await expect(oauth.logout()).rejects.toThrow("derived settings failed");
    await vi.waitFor(() => expect(terminal.socket.readyState).toBe(WebSocket.CLOSED));
    expect(f.manager.getStatus(1)).toEqual({ status: "auth-required" });
    expect(credentials.has("zcodejwttoken")).toBe(false);
    expect(f.settings.webRemoteControlLastEnabledContext).toEqual({ workspacePath: "/workspace" });
  });
  it("a 503 on first registration is handed to connection backoff recovery; no second start click is needed", async () => {
    let registrations = 0;
    const f = await fixture({
      onHttp: (call) => {
        if (call.path === "/api/v1/remote/device" && ++registrations === 1) return { status: 503 };
      },
    });
    const result = await f.start();
    expect(result.status).toBe("running");
    expect(registrations).toBe(2);
    expect(f.settings.webRemoteControlLastEnabledContext).toEqual({ workspacePath: "/workspace" });
  });
  it("stopping during first-registration backoff revokes later registration and start", async () => {
    const f = await fixture({
      onHttp: (call) => (call.path === "/api/v1/remote/device" ? { status: 503 } : undefined),
    });
    const started = f.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.relay.httpCalls).toHaveLength(1));
    expect(f.manager.getStatus(1).status).toBe("starting");
    await f.manager.stop(1);
    expect(await started).toBeInstanceOf(Error);
    await delay(1400);
    expect(f.relay.httpCalls).toHaveLength(1);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });
  it("switching accounts directly revokes the old identity; the old account cannot access the workspace; the new account can connect; duplicate notifications are idempotent", async () => {
    const f = await fixture();
    const first = await f.start();
    f.manager.syncAvailableWorkspaces(1, [{ workspacePath: "/workspace", kind: "local" }]);
    f.setLogin({ userId: "other-user", jwt: "other" });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    const next = f.manager.getStatus(1);
    expect(next.status).toBe("running");
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(f.settings.webRemoteControlRelayV2Device?.userId).toBe("other-user");
    const old = await connectTerminal(f.relay, "jwt", first.sessionId!);
    expect(old.messages).toContainEqual(
      expect.objectContaining({ type: "auth_ack", pair_status: "waiting" }),
    );
    requestBootstrap(old.socket);
    await vi.waitFor(() =>
      expect(old.messages).toContainEqual(
        expect.objectContaining({ type: "error", code: "INTERNAL" }),
      ),
    );
    expect(old.messages.some((message) => message.type === "data")).toBe(false);
    const current = await connectTerminal(f.relay, "other", next.sessionId!);
    requestBootstrap(current.socket);
    await vi.waitFor(() =>
      expect(current.messages).toContainEqual(
        expect.objectContaining({
          type: "data",
          payload: expect.objectContaining({ zcode_type: "bootstrap-response" }),
        }),
      ),
    );
    const calls = f.relay.httpCalls.length;
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.relay.httpCalls).toHaveLength(calls);
  });
  it("switching accounts revokes all old windows and restores only the synced last-enabled target", async () => {
    const f = await fixture();
    await f.start();
    const second = { workspacePath: "/second" };
    f.manager.syncAvailableWorkspaces(1, [{ workspacePath: "/workspace", kind: "local" }]);
    f.manager.syncAvailableWorkspaces(2, [{ ...second, kind: "local" }]);
    await f.manager.startAuthorized(2, second, f.manager.authorizeStart(2, second));
    f.setLogin({ userId: "other-user", jwt: "other" });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.manager.getStatus(2)).toMatchObject({ status: "running", workspacePath: "/second" });
    expect(f.settings.webRemoteControlRelayV2Device?.userId).toBe("other-user");
    const old = await fetch(`${f.relay.httpUrl}/api/v1/remote/device`, {
      headers: { Authorization: "Bearer jwt" },
    });
    const { data: oldDevices } = await old.json();
    expect(oldDevices.every((device: { online: boolean }) => !device.online)).toBe(true);
  });
  it("a login notification arriving during the first identity read discards the old read and starts with the new identity", async () => {
    const f = await fixture();
    const stale = Promise.withResolvers<{ userId: string; jwt: string }>();
    f.readLogin.mockReturnValueOnce(stale.promise);
    const started = f.start();
    await vi.waitFor(() => expect(f.readLogin).toHaveBeenCalledOnce());
    f.setLogin({ userId: "other-user", jwt: "other" });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    stale.resolve({ userId: "user", jwt: "jwt" });
    expect((await started).status).toBe("running");
    expect(f.settings.webRemoteControlRelayV2Device?.userId).toBe("other-user");
    expect(f.relay.httpCalls.every((call) => call.userId === "other-user")).toBe(true);
  });
  it("switching accounts revokes a pending start bound to the old identity; a late read cannot overwrite the new connection", async () => {
    const context = { workspacePath: "/workspace", kind: "local" as const };
    const f = await fixture({}, { webRemoteControlLastEnabledContext: context });
    f.manager.syncAvailableWorkspaces(1, [context]);
    const stale = Promise.withResolvers<{ userId: string; jwt: string }>();
    f.readLogin
      .mockResolvedValueOnce({ userId: "user", jwt: "jwt" })
      .mockReturnValueOnce(stale.promise);
    const started = f.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.readLogin).toHaveBeenCalledTimes(2));
    f.setLogin({ userId: "other-user", jwt: "other" });
    const notification = f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    await vi.waitFor(() => expect(f.readLogin).toHaveBeenCalledTimes(3));
    stale.resolve({ userId: "user", jwt: "jwt" });
    await notification;
    expect(await started).toBeInstanceOf(Error);
    expect(f.manager.getStatus(1).status).toBe("running");
    expect(f.settings.webRemoteControlRelayV2Device?.userId).toBe("other-user");
    expect(f.relay.httpCalls.every((call) => call.userId === "other-user")).toBe(true);
  });

  it("lazily registers, migrates V1, persists the identity, returns a keyless V4 QR code, and reuses the SID on restart", async () => {
    const f = await fixture();
    expect(f.relay.httpCalls).toEqual([]);
    const result = await f.start();
    expect(f.settings.webRemoteControlRelayV2Device).toEqual({
      deviceSid: result.sessionId,
      userId: "user",
      endpointOrigin: f.relay.httpUrl,
    });
    expect(f.settings.webRemoteControlExternalRelayDevice).toBeUndefined();
    expect(f.credentials.size).toBe(0);
    const url = new URL(result.qrUrl);
    expect(url.pathname).toBe("/remote/v4");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_version: "3.13.0",
      sid: result.sessionId,
      mid: "desktop-mid",
      name: "Desktop name",
    });
    expect(f.manager.getStatus(1)).toMatchObject({ status: "running", mobileConnected: false });
    const again = await f.start();
    expect(again.sessionId).toBe(result.sessionId);
    expect(f.relay.httpCalls.filter((call) => call.path === "/api/v1/remote/device")).toHaveLength(
      1,
    );
  });
  it("adds the pk pairing code to the QR only when a device-key pairing source is configured", async () => {
    const issueCode = vi.fn(async () => "pairing-code-0123456789");
    const f = await fixture({}, {}, undefined, { issueCode });
    const result = await f.start();
    expect(new URL(result.qrUrl).searchParams.get("pk")).toBe("pairing-code-0123456789");
    expect(issueCode).toHaveBeenCalledWith(
      expect.objectContaining({ relayOrigin: f.relay.httpUrl }),
    );
    const plain = await fixture();
    expect(new URL((await plain.start()).qrUrl).searchParams.has("pk")).toBe(false);
  });

  it("fails the start instead of publishing a QR the phone cannot sign in with", async () => {
    const f = await fixture({}, {}, undefined, { issueCode: async () => undefined });
    await expect(f.start()).rejects.toMatchObject({ reason: "relay-unavailable" });
  });

  it("keeps a device-key session running when the z.ai account signs out", async () => {
    const f = await fixture(
      {},
      {},
      undefined,
      { issueCode: async () => "pairing-code-0123456789" },
      true,
    );
    await f.start();
    await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
    expect(f.manager.getStatus(1)).toMatchObject({ status: "running" });
  });

  it("no JWT fails explicitly without registering or connecting", async () => {
    const f = await fixture();
    f.setLogin(undefined);
    await expect(f.start()).rejects.toMatchObject({ reason: "auth-required" });
    expect(f.relay.httpCalls).toEqual([]);
    expect(f.relay.messages).toEqual([]);
    expect(f.manager.getStatus(1)).toMatchObject({ status: "auth-required" });
  });
  it("a cold start without a JWT waits; the login notification resumes only after workspace sync, and duplicate notifications do not reconnect", async () => {
    const context = { workspacePath: "/workspace", kind: "local" as const };
    const f = await fixture({}, { webRemoteControlLastEnabledContext: context });
    f.setLogin(undefined);
    expect(await f.manager.restorePreviouslyEnabled(1, [context])).toBe(false);
    expect(f.manager.getStatus(1).status).toBe("auth-required");
    expect(f.relay.httpCalls).toEqual([]);
    expect(f.relay.messages).toEqual([]);
    f.setLogin({ jwt: "jwt", userId: "user" });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.manager.getStatus(1).status).toBe("running");
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.relay.httpCalls.filter((call) => call.path.endsWith("/token"))).toHaveLength(1);
  });
  it("login before workspace sync waits; logout stops and keeps the target; logging in again can resume", async () => {
    const context = { workspacePath: "/workspace", workspaceIdentity: "ssh://host/repo" };
    const f = await fixture({}, { webRemoteControlLastEnabledContext: context });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.relay.httpCalls).toEqual([]);
    expect(
      await f.manager.restorePreviouslyEnabled(1, [{ ...context, remoteSessionId: "new-session" }]),
    ).toBe(true);
    f.setLogin(undefined);
    await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
    expect(f.manager.getStatus(1)).toEqual({ status: "auth-required" });
    expect(f.settings.webRemoteControlLastEnabledContext).toMatchObject(context);
    f.setLogin({ jwt: "jwt", userId: "user" });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.manager.getStatus(1)).toMatchObject({
      status: "running",
      remoteSessionId: "new-session",
    });
    await f.manager.stop(1);
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });
  it("a fake login notification cannot bypass the JWT gate", async () => {
    const f = await fixture(
      {},
      { webRemoteControlLastEnabledContext: { workspacePath: "/workspace" } },
    );
    f.setLogin(undefined);
    f.manager.syncAvailableWorkspaces(1, [{ workspacePath: "/workspace", kind: "local" }]);
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.manager.getStatus(1).status).toBe("auth-required");
    expect(f.relay.httpCalls).toEqual([]);
    expect(f.relay.messages).toEqual([]);
  });
  it("after a 401 the manager waits for a login notification; repeated workspace sync cannot register again with the invalid JWT", async () => {
    const context = { workspacePath: "/workspace", kind: "local" as const };
    const f = await fixture(
      { onHttp: () => ({ status: 401 }) },
      { webRemoteControlLastEnabledContext: context },
    );
    await expect(f.start()).rejects.toMatchObject({ reason: "auth-required" });
    expect(f.manager.getStatus(1).status).toBe("auth-required");
    const calls = f.relay.httpCalls.length;
    expect(await f.manager.restorePreviouslyEnabled(1, [context])).toBe(false);
    expect(f.relay.httpCalls).toHaveLength(calls);
  });
  it("logout revokes a pending start and a late login notification, creating no host or connection", async () => {
    const f = await fixture(
      {},
      { webRemoteControlLastEnabledContext: { workspacePath: "/workspace" } },
    );
    const pendingLogin = Promise.withResolvers<{ jwt: string; userId: string }>();
    f.readLogin.mockReturnValueOnce(pendingLogin.promise);
    const pendingStart = f.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.readLogin).toHaveBeenCalledOnce());
    f.setLogin(undefined);
    await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
    pendingLogin.resolve({ jwt: "jwt", userId: "user" });
    expect(await pendingStart).toBeInstanceOf(Error);
    const lateLogin = Promise.withResolvers<{ jwt: string; userId: string }>();
    f.readLogin.mockReturnValueOnce(lateLogin.promise);
    const notification = f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
    lateLogin.resolve({ jwt: "jwt", userId: "user" });
    await notification;
    expect(f.manager.getStatus(1).status).toBe("auth-required");
    expect(f.relay.httpCalls).toEqual([]);
    expect(f.relay.messages).toEqual([]);
    expect(f.attachWorkspaceHost).not.toHaveBeenCalled();
    expect(f.settings.webRemoteControlLastEnabledContext).toEqual({ workspacePath: "/workspace" });
  });
  it("manual stop and closing the window invalidate a start-recovery that is still reading", async () => {
    const context = { workspacePath: "/workspace" };
    const f = await fixture({}, { webRemoteControlLastEnabledContext: context });
    const load = Promise.withResolvers<typeof context>();
    f.loadEnabled.mockReturnValueOnce(load.promise);
    const restore = f.manager.restorePreviouslyEnabled(1, [context]);
    await f.manager.stop(1);
    load.resolve(context);
    expect(await restore).toBe(false);
    expect(f.relay.httpCalls).toEqual([]);
    expect(f.attachWorkspaceHost).not.toHaveBeenCalled();
  });
  it("a full mixed-workspace sync keeps the local target; closing a target during a storage read does not restore an old snapshot", async () => {
    const local = { workspacePath: "/workspace", kind: "local" as const, label: "Local" };
    const remote = {
      workspacePath: "/remote",
      workspaceIdentity: "ssh://host/remote",
      remoteSessionId: "remote-1",
      kind: "remote" as const,
      label: "Remote",
    };
    const f = await fixture({}, { webRemoteControlLastEnabledContext: local });
    f.setLogin(undefined);
    await f.manager.restorePreviouslyEnabled(1, [local, remote]);
    f.setLogin({ jwt: "jwt", userId: "user" });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.manager.getStatus(1)).toMatchObject({
      status: "running",
      workspacePath: "/workspace",
    });
    await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
    const pending = Promise.withResolvers<typeof local>();
    f.loadEnabled.mockReturnValueOnce(pending.promise);
    const login = f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    await vi.waitFor(() => expect(f.loadEnabled).toHaveBeenCalledTimes(3));
    f.manager.syncAvailableWorkspaces(1, [remote]);
    pending.resolve(local);
    await login;
    expect(f.manager.getStatus(1).status).toBe("idle");
  });
  it("remote recovery waits for the current remoteSessionId and does not start a relay for an offline placeholder tab", async () => {
    const context = { workspacePath: "/remote", workspaceIdentity: "ssh://host/remote" };
    const f = await fixture({}, { webRemoteControlLastEnabledContext: context });
    expect(await f.manager.restorePreviouslyEnabled(1, [context])).toBe(false);
    expect(f.relay.httpCalls).toEqual([]);
    expect(f.attachWorkspaceHost).not.toHaveBeenCalled();
  });
  it("switching accounts re-registers; start still succeeds when deleting the old record is not permitted", async () => {
    const f = await fixture();
    const first = await f.start();
    f.setLogin({ userId: "other-user", jwt: "other" });
    const next = await f.start();
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(f.settings.webRemoteControlRelayV2Device?.userId).toBe("other-user");
    expect(
      f.relay.httpCalls.some(
        (call) => call.path.endsWith("/delete") && call.userId === "other-user",
      ),
    ).toBe(true);
  });
  it("switching endpoints re-registers and never sends a JWT for the new domain to the old one", async () => {
    const f = await fixture();
    const first = await f.start();
    const other = await createFakeRelayV2({ users: { jwt: "user" } });
    cleanups.push(() => other.close());
    f.setEndpoint(other.httpUrl);
    const next = await f.start();
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(f.settings.webRemoteControlRelayV2Device?.endpointOrigin).toBe(other.httpUrl);
    expect(f.relay.httpCalls.some((call) => call.path.endsWith("/delete"))).toBe(false);
  });
  it("auth_init AUTH_FAILED closes the old socket and re-registers once", async () => {
    let failed = false;
    const f = await fixture({
      onMessage: ({ message }) => {
        if (!failed && (message as { type: string }).type === "auth_init") {
          failed = true;
          return { error: "AUTH_FAILED" };
        }
      },
    });
    await f.start();
    expect(f.relay.httpCalls.filter((call) => call.path === "/api/v1/remote/device")).toHaveLength(
      2,
    );
    expect(f.manager.getStatus(1)).toMatchObject({ status: "running" });
  });
  it("token 401 stops and keeps auth-required and the last enablement intent", async () => {
    let deny = false;
    const f = await fixture({
      onHttp: (call) => (deny && call.path.endsWith("/token") ? { status: 401 } : undefined),
    });
    await f.start();
    deny = true;
    f.relay.disconnect({ role: "device" });
    await vi.waitFor(
      () =>
        expect(f.manager.getStatus(1)).toMatchObject({
          status: "auth-required",
        }),
      { timeout: 4000 },
    );
    expect(f.settings.webRemoteControlLastEnabledContext).toEqual({ workspacePath: "/workspace" });
    expect(f.settings.webRemoteControlRelayV2Device).toBeDefined();
  });
  it("bounded KICKED recovery ultimately reports session-conflict externally", async () => {
    const f = await fixture();
    await f.start();
    f.relay.sendError({ role: "device" }, "KICKED");
    await vi.waitFor(() => expect(f.relay.messages.length).toBe(2), { timeout: 6500 });
    f.relay.sendError({ role: "device" }, "KICKED");
    await vi.waitFor(() =>
      expect(f.manager.getStatus(1)).toMatchObject({
        status: "error",
        failure: { reason: "session-conflict" },
      }),
    );
  });

  it("AUTH_FAILED re-registration hitting a 5xx backs off and retries registration without reusing the invalid SID", async () => {
    let firstSid: string | undefined;
    let registrations = 0;
    const f = await fixture({
      onMessage: ({ message }) => {
        const wire = message as { type: string; device_sid: string };
        if (wire.type !== "auth_init") return;
        firstSid ??= wire.device_sid;
        if (wire.device_sid === firstSid) return { error: "AUTH_FAILED" };
      },
      onHttp: (call) => {
        if (call.path === "/api/v1/remote/device" && ++registrations === 2) return { status: 503 };
      },
    });
    const result = await f.start();
    expect(result.sessionId).not.toBe(firstSid);
    expect(registrations).toBe(3);
  });
  it.each(["/device", "/token"])(
    "%s: after the first start call times out, background recovery still saves the enablement intent",
    async (path) => {
      let failing = true;
      const f = await fixture({
        onHttp: (call) => (call.path.endsWith(path) && failing ? { status: 503 } : undefined),
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const first = f.start().catch((error: Error) => error);
      await delay(60);
      await vi.advanceTimersByTimeAsync(30000);
      expect(await first).toBeInstanceOf(Error);
      failing = false;
      await delay(40);
      await vi.advanceTimersByTimeAsync(30000);
      await delay(80);
      expect(f.manager.getStatus(1).status).toBe("running");
      expect(f.settings.webRemoteControlLastEnabledContext).toEqual({
        workspacePath: "/workspace",
      });
    },
  );
  it("a token 401 terminal state cannot be overwritten by a remote workspace close notification", async () => {
    const f = await fixture({
      onHttp: (call) => (call.path.endsWith("/token") ? { status: 401 } : undefined),
    });
    await expect(
      f.start({ workspacePath: "/workspace", remoteSessionId: "remote-1" }),
    ).rejects.toMatchObject({ reason: "auth-required" });
    f.manager.failRemoteSession("remote-1", "closed", { reason: "workspace-closed" });
    expect(f.manager.getStatus(1)).toMatchObject({
      status: "auth-required",
    });
  });
});
