import type { WebRemoteControlFailure, WebRemoteControlV2QrParams } from "@zcode/shared";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";
import type { WebAuthService } from "#src/auth/webAuthService.js";

export interface WebRemoteControlDeviceGroup {
  deviceMid: string;
  name?: string;
  /** relay meta.platform (darwin / win32 / linux, etc.); falls back to the locally remembered platform when offline. */
  platform?: string;
  onlineConnections: WebRemoteControlRelayV2Device[];
}

/** Display info for online devices seen on this machine; at least one of name / platform is non-empty. */
export interface KnownDevice {
  name?: string;
  platform?: string;
}

/** Read-only display profile for the account row on the device page; not a login fact, the login gate still relies on the JWT. */
export interface WebRemoteControlDeviceListAccount {
  displayName: string;
  avatarUrl?: string;
  provider: WebOAuthProviderId;
}

export type WebRemoteControlDeviceListView = {
  kind: "devices";
  devices: WebRemoteControlDeviceGroup[];
  loading: boolean;
  error: boolean;
  account?: WebRemoteControlDeviceListAccount;
};

export type WebRemoteControlEntryView =
  | { kind: "callback" | "login" }
  | WebRemoteControlDeviceListView
  | { kind: "failure"; failure: WebRemoteControlFailure }
  | { kind: "repair-needed"; message: string };

export interface WebRemoteControlEntryConnection {
  params: WebRemoteControlV2QrParams & { deviceSid: string };
  signal: AbortSignal;
  getToken(signal: AbortSignal): Promise<string>;
  onPaired(): void;
  onFailure(failure: WebRemoteControlFailure): void;
}

export interface WebRemoteControlEntryOptions {
  // Browser location/history/storage are injected through existing boundaries; no second copy of login facts is stored.
  auth: Pick<WebAuthService, "getZCodeJwtToken" | "getActiveAccount" | "startLogin" | "logout">;
  getHref(): string;
  replaceHref(href: string): void;
  storage: Pick<Storage, "getItem" | "setItem">;
  locale: "zh-CN" | "en-US";
  devices(jwt: string, signal: AbortSignal): Promise<WebRemoteControlRelayV2Device[]>;
  subscribeVisible(listener: () => void): () => void;
  loginOptions?: Parameters<WebAuthService["startLogin"]>[0];
  // Localized re-pair notice for QR links carrying the V1 `hash`/`t` credential; defaults to the locale-based copy.
  repairNotice?: string;
  token(jwt: string, signal: AbortSignal): Promise<string>;
  /**
   * Fork device-key relay mode: exchanges the QR `pk` pairing code for a relay JWT, so a phone with
   * no z.ai login can reach the Desktop's devices. Omitted when the build does not support it.
   */
  pairing?: { exchange(code: string, signal: AbortSignal): Promise<string> };
  connect(connection: WebRemoteControlEntryConnection): void;
  onView(view: WebRemoteControlEntryView): void;
}

export type * from "#src/web-remote-control/contracts/transport.js";
