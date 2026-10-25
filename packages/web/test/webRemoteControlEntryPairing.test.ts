import { describe, expect, it, vi } from "vitest";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import { WebRemoteControlEntry } from "#src/web-remote-control/index.js";

function setup(options: {
  href: string;
  jwt?: string | null;
  exchange?: (code: string) => Promise<string>;
  withPairing?: boolean;
}) {
  let href = options.href;
  const auth = {
    getZCodeJwtToken: () => options.jwt ?? null,
    getActiveAccount: () => null,
    startLogin: vi.fn(),
    logout: vi.fn(async () => {}),
  };
  const token = vi.fn(async () => "one-use-token");
  const devices = vi.fn(async () => []);
  const connect = vi.fn();
  const onView = vi.fn();
  const exchange = vi.fn(options.exchange ?? (async () => "relay-jwt-from-pairing"));
  const entry = new WebRemoteControlEntry({
    auth,
    token,
    connect,
    onView,
    devices,
    getHref: () => href,
    replaceHref: (next) => {
      href = next;
    },
    storage: { getItem: () => null, setItem: () => {} },
    locale: "en-US",
    subscribeVisible: () => () => {},
    ...(options.withPairing === false ? {} : { pairing: { exchange } }),
  });
  return { entry, token, devices, connect, onView, exchange, href: () => href };
}

const QR = "https://relay.example.com/remote/v4?sid=device-1&mid=mid-1#pk=pairing-code-0123456789";
const LEGACY_QR =
  "https://relay.example.com/remote/v4?sid=device-1&mid=mid-1&pk=pairing-code-0123456789";

describe("device-key pairing entry", () => {
  it("exchanges pk without a z.ai login, removes it from the address bar and keeps the JWT in memory", async () => {
    const s = setup({ href: QR });
    await s.entry.start();
    expect(s.exchange).toHaveBeenCalledWith("pairing-code-0123456789", expect.any(AbortSignal));
    expect(new URL(s.href()).hash).toBe("");
    expect(new URL(s.href()).searchParams.has("pk")).toBe(false);
    expect(new URL(s.href()).searchParams.get("sid")).toBe("device-1");
    expect(s.onView).not.toHaveBeenCalledWith({ kind: "login" });
    const connection = s.connect.mock.calls[0]![0];
    await connection.getToken(new AbortController().signal);
    expect(s.token).toHaveBeenCalledWith("relay-jwt-from-pairing", expect.any(AbortSignal));
  });

  it("lists devices with the paired JWT when the QR has no sid", async () => {
    const s = setup({ href: "https://relay.example.com/remote/v4?pk=pairing-code-0123456789" });
    await s.entry.start();
    expect(s.devices).toHaveBeenCalledWith("relay-jwt-from-pairing", expect.any(AbortSignal));
  });

  it("shows an expired-session failure, not the login page, when the code is rejected", async () => {
    const s = setup({
      href: QR,
      exchange: async () => {
        throw new WebRemoteControlV2ConnectionError("auth-required");
      },
    });
    await s.entry.start();
    expect(s.onView).toHaveBeenCalledWith({
      kind: "failure",
      failure: { reason: "session-expired" },
    });
    expect(s.connect).not.toHaveBeenCalled();
    expect(new URL(s.href()).searchParams.has("pk")).toBe(false);
  });

  it("still accepts pk in the query for QR codes from older Desktops and strips it", async () => {
    const s = setup({ href: LEGACY_QR });
    await s.entry.start();
    expect(s.exchange).toHaveBeenCalledWith("pairing-code-0123456789", expect.any(AbortSignal));
    expect(new URL(s.href()).searchParams.has("pk")).toBe(false);
    expect(new URL(s.href()).searchParams.get("sid")).toBe("device-1");
  });

  it("keeps other fragment parameters when it removes pk", async () => {
    const s = setup({ href: `${QR}&view=a` });
    await s.entry.start();
    expect(new URLSearchParams(new URL(s.href()).hash.slice(1)).toString()).toBe("view=a");
  });

  it("keeps the z.ai login path unchanged and drops a stray pk without exchanging it", async () => {
    const s = setup({ href: QR, jwt: "login-jwt" });
    await s.entry.start();
    expect(s.exchange).not.toHaveBeenCalled();
    expect(new URL(s.href()).searchParams.has("pk")).toBe(false);
    const connection = s.connect.mock.calls[0]![0];
    await connection.getToken(new AbortController().signal);
    expect(s.token).toHaveBeenCalledWith("login-jwt", expect.any(AbortSignal));
  });

  it("still asks for login when there is neither a z.ai JWT nor a pairing code", async () => {
    const s = setup({ href: "https://relay.example.com/remote/v4?sid=device-1" });
    await s.entry.start();
    expect(s.onView).toHaveBeenCalledWith({ kind: "login" });
    const noPairing = setup({ href: QR, withPairing: false });
    await noPairing.entry.start();
    expect(noPairing.onView).toHaveBeenCalledWith({ kind: "login" });
  });
});
