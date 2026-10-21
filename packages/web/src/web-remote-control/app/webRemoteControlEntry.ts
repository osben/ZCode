import type {
  WebRemoteControlDeviceListView,
  WebRemoteControlEntryConnection,
  WebRemoteControlEntryOptions,
  WebRemoteControlDeviceGroup,
} from "#src/web-remote-control/contract.js";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import { parseWebRemoteControlExternalQrParams } from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";
import { groupWebRemoteControlDevices } from "#src/web-remote-control/domain/webRemoteControlDeviceGroups.js";
import { resolveWebRemoteControlRepairNotice } from "#src/web-remote-control/domain/webRemoteControlRepairNotice.js";
import {
  readKnownDevices,
  rememberKnownDevices,
} from "#src/web-remote-control/app/webRemoteControlKnownDevices.js";

export function isWebRemoteControlOAuthCallback(url: URL): boolean {
  return (
    ["/remote/v4", "/remote/v4/"].includes(url.pathname) &&
    url.searchParams.has("state") &&
    // BigModel uses authCode; it must first go through the existing callback validation and must not fall back to the logged-out gate.
    (url.searchParams.has("code") ||
      url.searchParams.has("authCode") ||
      url.searchParams.has("error"))
  );
}

const LAST_DEVICE_KEY = "zcode-web-remote-last-device-sid";
const LAST_DEVICE_MID_KEY = "zcode-web-remote-last-device-mid";

/**
 * Auto-landing for recent devices: an online recent SID wins; otherwise, when exactly one SID on the same computer (recent MID) is online, connect to it.
 * Desktop re-registration issues a new SID and makes a best-effort attempt to delete the old one, so when the recent MID is missing, only the offline record of the old SID in the list can be used.
 * When the same MID has multiple online SIDs, the target is not guessed; the user chooses from the list.
 */
function resolveAutoConnectSid(
  records: readonly WebRemoteControlRelayV2Device[],
  groups: readonly WebRemoteControlDeviceGroup[],
  lastSid: string | null,
  lastMid: string | null,
): string | undefined {
  if (!lastSid && !lastMid) return undefined;
  const lastRecord = lastSid ? records.find((record) => record.device_sid === lastSid) : undefined;
  if (lastRecord?.online) return lastRecord.device_sid;
  const mid = lastMid || lastRecord?.device_mid;
  const connections = groups.find((group) => group.deviceMid === mid)?.onlineConnections ?? [];
  return connections.length === 1 ? connections[0]?.device_sid : undefined;
}

/** Only handles admission before connecting; workspace/recovery after pairing still belongs to the existing bootstrap. */
export class WebRemoteControlEntry {
  private scope = new AbortController();
  /** Relay JWT from a device-key pairing code. Memory only: a reload requires a fresh QR. */
  private pairedJwt: string | undefined;
  private list:
    | {
        view: WebRemoteControlDeviceListView;
        unsubscribe: () => void;
        request?: Promise<void>;
        lastSid: string | null;
        lastMid: string | null;
        acceptedJwt?: string;
      }
    | undefined;

  constructor(private readonly options: WebRemoteControlEntryOptions) {}

  dispose(): void {
    this.scope.abort();
    this.list?.unsubscribe();
    this.list = undefined;
  }

  private reset(): void {
    this.dispose();
    this.scope = new AbortController();
  }

  async start(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    if (isWebRemoteControlOAuthCallback(url)) {
      this.options.onView({ kind: "callback" });
      return;
    }
    // V1 links carry `hash`/`t` and V2 rejects them; tell the user to re-pair instead of a generic failure.
    if (url.searchParams.has("hash") || url.searchParams.has("t")) {
      this.options.onView({
        kind: "repair-needed",
        message:
          this.options.repairNotice ?? resolveWebRemoteControlRepairNotice(this.options.locale),
      });
      return;
    }
    // `pk` travels in the fragment (never sent to the web host); QR codes from older Desktops put it in the query.
    const fragmentParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const pairingCode = (fragmentParams.get("pk") ?? url.searchParams.get("pk"))?.trim();
    if (fragmentParams.has("pk") || url.searchParams.has("pk")) {
      // The pairing code is a credential: take it out of the address bar and history before anything else.
      fragmentParams.delete("pk");
      url.searchParams.delete("pk");
      url.hash = fragmentParams.toString();
      this.options.replaceHref(url.href);
    }
    if (!this.options.auth.getZCodeJwtToken() && pairingCode && this.options.pairing) {
      try {
        this.pairedJwt = await this.options.pairing.exchange(pairingCode, this.scope.signal);
      } catch {
        if (this.scope.signal.aborted) return;
        // A spent or expired code cannot be retried; the phone has to scan a fresh QR.
        this.options.onView({ kind: "failure", failure: { reason: "session-expired" } });
        return;
      }
      if (this.scope.signal.aborted) return;
    }
    if (!this.bearer()) {
      this.options.onView({ kind: "login" });
      return;
    }
    const params = parseWebRemoteControlExternalQrParams(url.searchParams);
    if (!params) {
      this.options.onView({ kind: "failure", failure: { reason: "invalid-mobile-connection" } });
      return;
    }
    if (!params.deviceSid) {
      await this.openDevices(true);
      return;
    }
    this.connect({ ...params, deviceSid: params.deviceSid });
  }

  /** The z.ai login JWT when present, otherwise the relay JWT obtained from a pairing code. */
  private bearer(): string | null {
    return this.options.auth.getZCodeJwtToken() ?? this.pairedJwt ?? null;
  }

  private async openDevices(autoConnect: boolean): Promise<void> {
    this.reset();
    let lastSid: string | null = null;
    let lastMid: string | null = null;
    try {
      if (autoConnect) {
        lastSid = this.options.storage.getItem(LAST_DEVICE_KEY);
        lastMid = this.options.storage.getItem(LAST_DEVICE_MID_KEY);
      }
    } catch {
      // Environments such as iOS private mode may disable storage; recent devices are only a preference and do not block entry.
    }
    const account = this.options.auth.getActiveAccount() ?? undefined;
    this.list = {
      view: {
        kind: "devices",
        devices: [],
        loading: false,
        error: false,
        ...(account ? { account } : {}),
      },
      unsubscribe: this.options.subscribeVisible(() => {
        void this.refreshDevices();
      }),
      lastSid,
      lastMid,
    };
    await this.refreshDevices();
  }

  async refreshDevices(): Promise<void> {
    const list = this.list;
    if (!list) return;
    if (list.request) return list.request;
    const jwt = this.bearer();
    if (!jwt) return this.switchAccount();
    if (list.acceptedJwt && list.acceptedJwt !== jwt) return this.start();
    const { signal } = this.scope;
    list.view = { ...list.view, loading: true, error: false };
    this.options.onView(list.view);
    list.request = (async () => {
      try {
        const devices = await this.options.devices(jwt, signal);
        if (signal.aborted) return;
        // Responses received after an account change must not provide device or auto-connect basis for the new account.
        if (this.bearer() !== jwt) return this.start();
        list.acceptedJwt = jwt;
        // First read the cache to fill in names/platforms for offline records, then write back this online record; they are display preferences only and do not enter admission.
        const knownDevices = readKnownDevices(this.options.storage);
        const groups = groupWebRemoteControlDevices(devices, this.options.locale, knownDevices);
        rememberKnownDevices(this.options.storage, knownDevices, groups);
        list.view = { ...list.view, devices: groups, loading: false, error: false };
        const autoSid = resolveAutoConnectSid(devices, groups, list.lastSid, list.lastMid);
        // Auto-landing only consumes the first successful list; later refreshes must not interrupt the user's selection.
        list.lastSid = null;
        list.lastMid = null;
        if (autoSid) this.selectDevice(autoSid);
        else this.options.onView(list.view);
      } catch (error) {
        if (signal.aborted) return;
        if (this.bearer() !== jwt) return this.start();
        if (
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          await this.switchAccount();
          return;
        }
        list.view = { ...list.view, loading: false, error: true };
        this.options.onView(list.view);
      } finally {
        list.request = undefined;
      }
    })();
    return list.request;
  }

  selectDevice(sid: string): void {
    if (!this.list || this.list.view.loading || this.list.view.error) return;
    if (this.list.acceptedJwt !== this.bearer()) {
      void this.start();
      return;
    }
    const device = this.list.view.devices
      .flatMap((group) => group.onlineConnections)
      .find((item) => item.device_sid === sid);
    if (!device) return;
    const url = new URL(this.options.getHref());
    url.searchParams.set("sid", device.device_sid);
    url.searchParams.set("mid", device.device_mid);
    const name = device.meta.name?.trim();
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    this.options.replaceHref(url.href);
    this.rememberDevice(device.device_sid, device.device_mid);
    this.connect({
      deviceSid: device.device_sid,
      deviceMid: device.device_mid,
      deviceName: name || undefined,
      appVersion: url.searchParams.get("app_version") || undefined,
    });
  }

  async chooseOtherDevice(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    for (const key of ["sid", "mid", "name", "hash", "t"]) url.searchParams.delete(key);
    this.options.replaceHref(url.href);
    await this.openDevices(false);
  }

  private rememberDevice(sid: string, mid: string | undefined): void {
    try {
      this.options.storage.setItem(LAST_DEVICE_KEY, sid);
      if (mid) this.options.storage.setItem(LAST_DEVICE_MID_KEY, mid);
    } catch {
      // A failure to persist preferences does not affect the connection and does not modify business state isolated by SID.
    }
  }

  private connect(params: WebRemoteControlEntryConnection["params"]): void {
    this.reset();
    const { signal } = this.scope;
    this.options.connect({
      params,
      signal,
      getToken: (tokenSignal) => {
        const jwt = this.bearer();
        if (!jwt) return Promise.reject(new WebRemoteControlV2ConnectionError("auth-required"));
        return this.options.token(jwt, tokenSignal);
      },
      onPaired: () => {
        if (!signal.aborted) this.rememberDevice(params.deviceSid, params.deviceMid);
      },
      onFailure: (failure) => {
        if (signal.aborted) return;
        if (
          failure.reason === "auth-required" &&
          this.pairedJwt &&
          !this.options.auth.getZCodeJwtToken()
        ) {
          // A paired relay JWT cannot be renewed with the spent code; ask for a new QR instead of the login page.
          this.pairedJwt = undefined;
          this.options.onView({ kind: "failure", failure: { reason: "session-expired" } });
        } else if (failure.reason === "auth-required") void this.switchAccount();
        else this.options.onView({ kind: "failure", failure });
      },
    });
  }

  startLogin(provider?: WebOAuthProviderId): void {
    this.options.auth.startLogin({
      ...this.options.loginOptions,
      ...(provider ? { provider } : {}),
      appReturnTo: this.options.getHref(),
    });
  }

  async switchAccount(): Promise<void> {
    this.reset();
    const { signal } = this.scope;
    if (this.pairedJwt && !this.options.auth.getZCodeJwtToken()) {
      this.pairedJwt = undefined;
      this.options.onView({ kind: "failure", failure: { reason: "session-expired" } });
      return;
    }
    await this.options.auth.logout();
    if (!signal.aborted) this.options.onView({ kind: "login" });
  }
}
