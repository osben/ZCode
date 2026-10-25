import { describe, expect, it, vi } from "vitest";
import {
  WebRemoteControlV2ConnectionError,
  type WebRemoteControlRelayV2Device,
} from "@zcode/shared/web-remote-relay";
import {
  WebRemoteControlEntry,
  type WebRemoteControlDeviceListAccount,
} from "#src/web-remote-control/index.js";
import { resolveWebRemoteControlRepairNotice } from "#src/web-remote-control/domain/webRemoteControlRepairNotice.js";

function setup(
  jwt: string | null = null,
  href = "https://zcode.z.ai/remote/v4?app_version=3.13.0&sid=device-1&mid=mid-1&name=Desktop",
  account: WebRemoteControlDeviceListAccount | null = null,
) {
  const auth = {
    getZCodeJwtToken: () => jwt,
    getActiveAccount: vi.fn(() => (jwt ? account : null)),
    startLogin: vi.fn(),
    logout: vi.fn(async () => {
      jwt = null;
    }),
  };
  const token = vi.fn(async () => "one-use-token");
  const connect = vi.fn();
  const onView = vi.fn();
  const devices = vi.fn<
    (jwt: string, signal: AbortSignal) => Promise<WebRemoteControlRelayV2Device[]>
  >(async () => []);
  const storage = new Map<string, string>();
  let visible: (() => void) | undefined;
  const storageAdapter = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const entry = new WebRemoteControlEntry({
    auth,
    token,
    connect,
    onView,
    getHref: () => href,
    devices,
    replaceHref: (next) => {
      href = next;
    },
    storage: storageAdapter,
    locale: "en-US",
    subscribeVisible: (listener) => {
      visible = listener;
      return () => {
        visible = undefined;
      };
    },
  });
  return {
    entry,
    auth,
    token,
    connect,
    onView,
    devices,
    storage,
    storageAdapter,
    setJwt: (value: string | null) => {
      jwt = value;
    },
    show: () => visible?.(),
    get href() {
      return href;
    },
  };
}

describe("V2 phone entry", () => {
  it("without a JWT, logs in first, keeps the full QR URL, and does not connect", async () => {
    const h = setup();
    await h.entry.start();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.token).not.toHaveBeenCalled();
    h.entry.startLogin();
    expect(h.auth.startLogin).toHaveBeenCalledWith({ appReturnTo: h.href });
  });
  it.each(["zai", "bigmodel"] as const)(
    "QR login passes the selected platform %s through and keeps the return address",
    async (provider) => {
      const h = setup();
      await h.entry.start();
      h.entry.startLogin(provider);
      expect(h.auth.startLogin).toHaveBeenCalledWith({ provider, appReturnTo: h.href });
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.token).not.toHaveBeenCalled();
    },
  );
  it.each([
    "code=code-1&state=state-1",
    "authCode=bigmodel-code&state=state-1",
    "error=access_denied&state=state-1",
  ])("callback takes priority over the login gate: %s", async (query) => {
    const h = setup(null, `https://zcode.z.ai/remote/v4/?${query}`);
    await h.entry.start();
    expect(h.onView).toHaveBeenCalledWith({ kind: "callback" });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("logged in but with no SID: fetches the current account's devices; an empty list does not connect", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    await h.entry.start();
    expect(h.onView).toHaveBeenLastCalledWith({
      kind: "devices",
      devices: [],
      loading: false,
      error: false,
    });
    expect(h.devices).toHaveBeenCalledWith("jwt", expect.any(AbortSignal));
    expect(h.token).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("with a SID, connects directly; re-reads the login state on every token request", async () => {
    const h = setup("jwt");
    await h.entry.start();
    const connection = h.connect.mock.calls[0][0];
    expect(connection.params).toEqual({
      deviceSid: "device-1",
      deviceMid: "mid-1",
      deviceName: "Desktop",
      appVersion: "3.13.0",
    });
    const signal = new AbortController().signal;
    expect(await connection.getToken(signal)).toBe("one-use-token");
    expect(h.token).toHaveBeenCalledWith("jwt", signal);
    await h.auth.logout();
    await expect(connection.getToken(signal)).rejects.toMatchObject({ reason: "auth-required" });
  });

  it("401 clears the session and returns to login; an account mismatch keeps the failure page until the user switches accounts", async () => {
    const h = setup("jwt");
    await h.entry.start();
    const connection = h.connect.mock.calls[0][0];
    connection.onFailure({ reason: "device-not-owned" });
    expect(h.onView).toHaveBeenLastCalledWith({
      kind: "failure",
      failure: { reason: "device-not-owned" },
    });
    expect(h.auth.logout).not.toHaveBeenCalled();
    await h.entry.switchAccount();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
    h.entry.startLogin();
    expect(h.auth.startLogin).toHaveBeenLastCalledWith({ appReturnTo: h.href });
    connection.onFailure({ reason: "auth-required" });
    await Promise.resolve();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
  });

  it("a V1 hash/t link shows the re-pair notice instead of a generic failure and does not connect", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4?sid=device-1&hash=secret&t=1");
    await h.entry.start();
    expect(h.onView).toHaveBeenCalledWith({
      kind: "repair-needed",
      message: resolveWebRemoteControlRepairNotice("en-US"),
    });
    expect(h.onView).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "failure" }));
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.token).not.toHaveBeenCalled();
  });

  it("a V1 t-only link also shows the re-pair notice, even before login", async () => {
    const h = setup(null, "https://zcode.z.ai/remote/v4?sid=device-1&t=1");
    await h.entry.start();
    expect(h.onView).toHaveBeenCalledWith({
      kind: "repair-needed",
      message: resolveWebRemoteControlRepairNotice("en-US"),
    });
    expect(h.auth.startLogin).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("uses the injected repairNotice text when one is provided", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4?hash=secret");
    const entry = new WebRemoteControlEntry({
      auth: h.auth,
      token: h.token,
      connect: h.connect,
      onView: h.onView,
      getHref: () => "https://zcode.z.ai/remote/v4?hash=secret",
      replaceHref: vi.fn(),
      devices: h.devices,
      storage: h.storageAdapter,
      locale: "en-US",
      subscribeVisible: () => () => undefined,
      repairNotice: "Injected notice",
    });
    await entry.start();
    expect(h.onView).toHaveBeenCalledWith({ kind: "repair-needed", message: "Injected notice" });
  });
});

const onlineDevice: WebRemoteControlRelayV2Device = {
  device_sid: "last-device",
  device_mid: "abcdefgh-1234",
  online: true,
  created_at: 1,
  meta: { name: "Alice’s MacBook" },
};

const singleOnlineGroup = (device: WebRemoteControlRelayV2Device) => ({
  deviceMid: device.device_mid,
  name: device.meta.name,
  onlineConnections: [device],
});

it("the same full MID with 1 online and 11 historical offline registrations shows only one device, and connection still selects the original SID", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const offline = Array.from({ length: 11 }, (_, index) => ({
    ...onlineDevice,
    device_sid: `history-${index}`,
    online: false,
    meta: {},
  }));
  h.devices.mockResolvedValue([...offline, onlineDevice]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    {
      deviceMid: onlineDevice.device_mid,
      name: "Alice’s MacBook",
      onlineConnections: [onlineDevice],
    },
  ]);
  await h.entry.refreshDevices();
  expect(h.onView.mock.lastCall[0].devices).toHaveLength(1);
  h.entry.selectDevice("history-0");
  expect(h.connect).not.toHaveBeenCalled();
  h.entry.selectDevice("last-device");
  expect(h.connect.mock.lastCall[0].params.deviceSid).toBe("last-device");
});

it("the same MID fully offline shows only one item; devices with different full MIDs but identical first eight characters must not be merged", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  h.devices.mockResolvedValue([
    { ...onlineDevice, online: false, meta: {} },
    { ...onlineDevice, device_sid: "history", online: false, meta: {} },
    {
      ...onlineDevice,
      device_sid: "another",
      device_mid: "abcdefgh-5678",
      online: false,
      meta: {},
    },
  ]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    { deviceMid: "abcdefgh-1234", name: undefined, onlineConnections: [] },
    { deviceMid: "abcdefgh-5678", name: undefined, onlineConnections: [] },
  ]);
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
});

it("multiple online SIDs stay inside the same device item; any of them can be explicitly selected, and old connections become invalid after refresh", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0");
  const other = { ...onlineDevice, device_sid: "other", meta: { name: "ZCode Dev" } };
  h.devices.mockResolvedValue([other, onlineDevice]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    {
      deviceMid: onlineDevice.device_mid,
      name: "Alice’s MacBook",
      onlineConnections: [onlineDevice, other],
    },
  ]);
  expect(h.connect).not.toHaveBeenCalled();
  h.devices.mockResolvedValue([onlineDevice, other]);
  await h.entry.refreshDevices();
  expect(h.onView.mock.lastCall[0].devices[0].onlineConnections).toEqual([onlineDevice, other]);
  h.devices.mockResolvedValue([{ ...onlineDevice, online: false, meta: {} }, other]);
  await h.entry.refreshDevices();
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
  h.entry.selectDevice("other");
  expect(Object.fromEntries(new URL(h.href).searchParams)).toEqual({
    app_version: "3.13.0",
    sid: "other",
    mid: onlineDevice.device_mid,
    name: "ZCode Dev",
  });
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("other");
  expect(h.storage.get("zcode-web-remote-last-device-mid")).toBe(onlineDevice.device_mid);
});

it("when the recent SID is online, prefers connecting to the original SID even if the same MID has other online connections", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const preferred = { ...onlineDevice, device_sid: "preferred", meta: { name: "ZCode Dev" } };
  h.storage.set("zcode-web-remote-last-device-sid", "preferred");
  h.devices.mockResolvedValue([onlineDevice, preferred]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.lastCall[0].params.deviceSid).toBe("preferred");
});

it("when the recent SID is offline and exactly one connection on the same computer is online, connects to it automatically; the MID comes from the offline record in the list", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const preferred = { ...onlineDevice, device_sid: "preferred", online: false, meta: {} };
  h.storage.set("zcode-web-remote-last-device-sid", "preferred");
  h.devices.mockResolvedValue([onlineDevice, preferred]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.lastCall[0].params).toMatchObject({
    deviceSid: "last-device",
    deviceMid: onlineDevice.device_mid,
  });
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("last-device");
  expect(h.storage.get("zcode-web-remote-last-device-mid")).toBe(onlineDevice.device_mid);
});

it("when the recent SID has been deleted, connects to the only online connection using the remembered recent MID", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  h.storage.set("zcode-web-remote-last-device-sid", "deleted-sid");
  h.storage.set("zcode-web-remote-last-device-mid", onlineDevice.device_mid);
  const otherMachine = { ...onlineDevice, device_mid: "mid-other", device_sid: "other-sid" };
  h.devices.mockResolvedValue([otherMachine, onlineDevice]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.lastCall[0].params.deviceSid).toBe("last-device");
});

it.each([
  [
    "same MID has multiple online connections",
    [onlineDevice, { ...onlineDevice, device_sid: "second" }],
  ],
  ["same MID fully offline", [{ ...onlineDevice, online: false, meta: {} }]],
  [
    "only other computers are online",
    [{ ...onlineDevice, device_mid: "mid-other", device_sid: "other-sid" }],
  ],
])(
  "when the recent SID is not online and %s, shows the list without guessing the connection target",
  async (_case, records) => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.storage.set("zcode-web-remote-last-device-sid", "deleted-sid");
    h.storage.set("zcode-web-remote-last-device-mid", onlineDevice.device_mid);
    h.devices.mockResolvedValue(records);
    await h.entry.start();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.onView.mock.lastCall[0].kind).toBe("devices");
  },
);

it("the list view carries the current account's display profile and keeps it after refresh", async () => {
  const account = { displayName: "Ada", provider: "zai" as const };
  const h = setup("jwt", "https://zcode.z.ai/remote/v4", account);
  h.devices.mockResolvedValue([{ ...onlineDevice, meta: { name: "Mac", platform: "darwin" } }]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0]).toMatchObject({
    account,
    devices: [{ deviceMid: onlineDevice.device_mid, platform: "darwin" }],
  });
  await h.entry.refreshDevices();
  expect(h.onView.mock.lastCall[0].account).toEqual(account);
});

it("the no-code entry automatically connects to the recent device that is online for the current account, and writes back a recoverable URL", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0&name=stale");
  h.storage.set("zcode-web-remote-last-device-sid", "last-device");
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.calls[0][0].params).toEqual({
    deviceSid: "last-device",
    deviceMid: "abcdefgh-1234",
    deviceName: "Alice’s MacBook",
    appVersion: "3.13.0",
  });
  const url = new URL(h.href);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    sid: "last-device",
    mid: "abcdefgh-1234",
    name: "Alice’s MacBook",
    app_version: "3.13.0",
  });
});

it("when the recent device is offline, online devices are sorted to the top by name; manual or return-to-foreground refresh does not auto-connect, and only one acceptance happens after selection", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0&name=stale");
  h.storage.set("zcode-web-remote-last-device-sid", "last-device");
  const offline = { ...onlineDevice, online: false, meta: {} };
  const beta = {
    ...onlineDevice,
    device_mid: "mid-beta",
    device_sid: "beta",
    meta: { name: "Beta" },
  };
  const alpha = {
    ...onlineDevice,
    device_mid: "mid-alpha",
    device_sid: "alpha",
    meta: { name: "Alpha" },
  };
  const unnamed = { ...onlineDevice, device_mid: "mid-unnamed", device_sid: "unnamed", meta: {} };
  h.devices.mockResolvedValue([offline, beta, unnamed, alpha]);
  await h.entry.start();
  expect(h.onView).toHaveBeenLastCalledWith({
    kind: "devices",
    devices: [
      singleOnlineGroup(alpha),
      singleOnlineGroup(beta),
      singleOnlineGroup(unnamed),
      { deviceMid: offline.device_mid, name: undefined, onlineConnections: [] },
    ],
    loading: false,
    error: false,
  });
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
  h.devices.mockResolvedValue([onlineDevice, unnamed]);
  await h.entry.refreshDevices();
  h.show();
  await vi.waitFor(() => expect(h.devices).toHaveBeenCalledTimes(3));
  expect(h.connect).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(h.onView).toHaveBeenLastCalledWith({
      kind: "devices",
      devices: [singleOnlineGroup(onlineDevice), singleOnlineGroup(unnamed)],
      loading: false,
      error: false,
    }),
  );
  h.entry.selectDevice("unnamed");
  h.entry.selectDevice("unnamed");
  expect(h.connect).toHaveBeenCalledOnce();
  expect(Object.fromEntries(new URL(h.href).searchParams)).toEqual({
    app_version: "3.13.0",
    sid: "unnamed",
    mid: "mid-unnamed",
  });
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("unnamed");
  h.show();
  expect(h.devices).toHaveBeenCalledTimes(3);
});

it("switching accounts cancels a concurrent refresh; a late list from the old account must not overwrite the login page", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const pending = Promise.withResolvers<WebRemoteControlRelayV2Device[]>();
  h.devices.mockReturnValue(pending.promise);
  const started = h.entry.start();
  h.show();
  void h.entry.refreshDevices();
  expect(h.devices).toHaveBeenCalledOnce();
  const signal = h.devices.mock.calls[0][1];
  await h.entry.switchAccount();
  expect(signal.aborted).toBe(true);
  pending.resolve([onlineDevice]);
  await started;
  expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
  expect(h.connect).not.toHaveBeenCalled();
  h.show();
  expect(h.devices).toHaveBeenCalledOnce();
});

it("a list refresh failure shows an error and disables the old list; a 401 returns to login and keeps the URL", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0");
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  h.devices.mockRejectedValueOnce(new Error("network"));
  await h.entry.refreshDevices();
  expect(h.onView).toHaveBeenLastCalledWith({
    kind: "devices",
    devices: [singleOnlineGroup(onlineDevice)],
    loading: false,
    error: true,
  });
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
  h.devices.mockRejectedValueOnce(new WebRemoteControlV2ConnectionError("auth-required"));
  await h.entry.refreshDevices();
  expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
  expect(h.auth.logout).toHaveBeenCalledOnce();
  h.entry.startLogin();
  expect(h.auth.startLogin).toHaveBeenCalledWith({ appReturnTo: h.href });
});

it("selecting another device releases the connection, removes the target parameter, and skips the recent device; old connection events are invalid", async () => {
  const h = setup("jwt");
  await h.entry.start();
  const old = h.connect.mock.calls[0][0];
  old.onPaired();
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("device-1");
  expect(h.storage.get("zcode-web-remote-last-device-mid")).toBe("mid-1");
  h.devices.mockResolvedValue([{ ...onlineDevice, device_sid: "device-1" }]);
  await h.entry.chooseOtherDevice();
  expect(old.signal.aborted).toBe(true);
  expect(Object.fromEntries(new URL(h.href).searchParams)).toEqual({ app_version: "3.13.0" });
  expect(h.connect).toHaveBeenCalledOnce();
  old.onFailure({ reason: "auth-required" });
  old.onPaired();
  expect(h.auth.logout).not.toHaveBeenCalled();
  expect(h.onView.mock.lastCall[0].kind).toBe("devices");
});

it("when the account changes after the list is shown, the old device selection goes through the current account's list again", async () => {
  const h = setup("alice", "https://zcode.z.ai/remote/v4");
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  h.setJwt("bob");
  h.devices.mockResolvedValue([]);
  h.entry.selectDevice("last-device");
  await vi.waitFor(() =>
    expect(h.devices).toHaveBeenLastCalledWith("bob", expect.any(AbortSignal)),
  );
  expect(h.connect).not.toHaveBeenCalled();
  expect(new URL(h.href).searchParams.has("sid")).toBe(false);
});

it("unavailable storage does not block manual selection; existing SID business state is kept as-is", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  h.storage.set("zcode-web-remote-client-id:last-device", "existing-client");
  vi.spyOn(h.storageAdapter, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(h.storageAdapter, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([singleOnlineGroup(onlineDevice)]);
  h.entry.selectDevice("last-device");
  expect(h.connect).toHaveBeenCalledOnce();
  h.connect.mock.calls[0][0].onPaired();
  expect(h.storage.get("zcode-web-remote-client-id:last-device")).toBe("existing-client");
});

it("does not connect when the recent SID does not belong to the current account; same-named devices are sorted by MID/SID and there is no polling", async () => {
  vi.useFakeTimers();
  try {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.storage.set("zcode-web-remote-last-device-sid", "other-account-device");
    const b = { ...onlineDevice, device_mid: "mid-b" };
    const a2 = { ...onlineDevice, device_mid: "mid-a", device_sid: "sid-2" };
    const a1 = { ...a2, device_sid: "sid-1" };
    h.devices.mockResolvedValue([b, a2, a1]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices).toEqual([
      { deviceMid: "mid-a", name: "Alice’s MacBook", onlineConnections: [a1, a2] },
      singleOnlineGroup(b),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.devices).toHaveBeenCalledOnce();
    expect(h.connect).not.toHaveBeenCalled();
    h.entry.dispose();
    h.show();
    expect(h.devices).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("during an aggregated list refresh all SIDs are rejected; after the refresh turns everything offline, the remembered names are kept but no connection is kept", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const other = { ...onlineDevice, device_sid: "other" };
  h.devices.mockResolvedValue([onlineDevice, other]);
  await h.entry.start();
  const pending = Promise.withResolvers<WebRemoteControlRelayV2Device[]>();
  h.devices.mockReturnValueOnce(pending.promise);
  const refreshed = h.entry.refreshDevices();
  h.entry.selectDevice("last-device");
  h.entry.selectDevice("other");
  expect(h.connect).not.toHaveBeenCalled();
  pending.resolve([onlineDevice, other].map((device) => ({ ...device, online: false, meta: {} })));
  await refreshed;
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    { deviceMid: onlineDevice.device_mid, name: "Alice’s MacBook", onlineConnections: [] },
  ]);
  h.entry.selectDevice("other");
  expect(h.connect).not.toHaveBeenCalled();
});

const DEVICE_NAMES_KEY = "zcode-web-remote-device-names";

describe("locally remembered device names and platforms", () => {
  it("writes the online platform to the cache; the next time the device is offline, the remembered platform is still shown", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.devices.mockResolvedValue([
      { ...onlineDevice, meta: { name: "Alice’s MacBook", platform: "darwin" } },
    ]);
    await h.entry.start();
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook", "darwin"],
    ]);
    const next = setup("jwt", "https://zcode.z.ai/remote/v4");
    next.storage.set(DEVICE_NAMES_KEY, h.storage.get(DEVICE_NAMES_KEY)!);
    next.devices.mockResolvedValue([{ ...onlineDevice, online: false, meta: {} }]);
    await next.entry.start();
    expect(next.onView.mock.lastCall[0].devices).toEqual([
      {
        deviceMid: "abcdefgh-1234",
        name: "Alice’s MacBook",
        platform: "darwin",
        onlineConnections: [],
      },
    ]);
  });

  it("writes the online device name to the local cache by MID; the next time the entry shows the device offline it displays the remembered name and it is still not connectable", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.devices.mockResolvedValue([onlineDevice]);
    await h.entry.start();
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook"],
    ]);
    // Simulates the next open: a new entry instance reuses the same localStorage content
    const next = setup("jwt", "https://zcode.z.ai/remote/v4");
    next.storage.set(DEVICE_NAMES_KEY, h.storage.get(DEVICE_NAMES_KEY)!);
    next.devices.mockResolvedValue([
      { ...onlineDevice, device_sid: "history", online: false, meta: {} },
    ]);
    await next.entry.start();
    expect(next.onView).toHaveBeenLastCalledWith({
      kind: "devices",
      devices: [{ deviceMid: "abcdefgh-1234", name: "Alice’s MacBook", onlineConnections: [] }],
      loading: false,
      error: false,
    });
    next.entry.selectDevice("history");
    expect(next.connect).not.toHaveBeenCalled();
  });

  it("when an online record has no name, falls back to the remembered name; after the computer is renamed, the refresh that brings it online overwrites the old name", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.storage.set(DEVICE_NAMES_KEY, JSON.stringify([["abcdefgh-1234", "Old Name"]]));
    h.devices.mockResolvedValue([{ ...onlineDevice, meta: {} }]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices[0].name).toBe("Old Name");
    h.devices.mockResolvedValue([{ ...onlineDevice, meta: { name: "  New Name  " } }]);
    await h.entry.refreshDevices();
    expect(h.onView.mock.lastCall[0].devices[0].name).toBe("New Name");
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([["abcdefgh-1234", "New Name"]]);
  });

  it("sorts offline devices by remembered name, with offline devices without a name last; a full-offline refresh does not write to the cache", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    const seeded = JSON.stringify([
      ["mid-b", "Beta"],
      ["mid-a", "Alpha"],
    ]);
    h.storage.set(DEVICE_NAMES_KEY, seeded);
    const offline = (mid: string) => ({
      ...onlineDevice,
      device_mid: mid,
      device_sid: `${mid}-sid`,
      online: false,
      meta: {},
    });
    h.devices.mockResolvedValue([offline("mid-c"), offline("mid-b"), offline("mid-a")]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices).toEqual([
      { deviceMid: "mid-a", name: "Alpha", onlineConnections: [] },
      { deviceMid: "mid-b", name: "Beta", onlineConnections: [] },
      { deviceMid: "mid-c", name: undefined, onlineConnections: [] },
    ]);
    expect(h.storage.get(DEVICE_NAMES_KEY)).toBe(seeded);
  });

  it("corrupted cache content is treated as empty and does not block the list; after a successful refresh it is rewritten as valid content", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.storage.set(DEVICE_NAMES_KEY, "{not json");
    h.devices.mockResolvedValue([
      onlineDevice,
      { ...onlineDevice, device_mid: "mid-x", device_sid: "sid-x", online: false, meta: {} },
    ]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices).toEqual([
      singleOnlineGroup(onlineDevice),
      { deviceMid: "mid-x", name: undefined, onlineConnections: [] },
    ]);
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook"],
    ]);
  });

  it("switching accounts does not clear the device name cache", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.devices.mockResolvedValue([onlineDevice]);
    await h.entry.start();
    await h.entry.switchAccount();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook"],
    ]);
  });
});
