import type { RelayDeviceKeySessionOperations, RelaySession } from "./deviceKeyContract.js";
import type {
  WebRemoteControlRelayV2Device,
  WebRemoteControlRelayV2Role,
  WebRemoteControlRelayV2IncomingMessage,
} from "@zcode/shared/web-remote-relay";

/** Durable device record. The relay stores nothing else about a device. */
export interface RelayDeviceRecord {
  deviceSid: string;
  userId: string;
  deviceMid: string;
  createdAt: number;
}

/** Owns device records only; online state and meta live in the connection registry. */
export interface RelayDeviceStore {
  register(userId: string, deviceMid: string, createdAt: number): Promise<RelayDeviceRecord>;
  listForUser(userId: string): Promise<RelayDeviceRecord[]>;
  get(deviceSid: string): Promise<RelayDeviceRecord | undefined>;
  /** Hard-deletes the record so the SID can no longer authenticate. Returns false when absent. */
  remove(deviceSid: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Relay-issued JWTs and the one-time exchange of the account login JWT.
 * Implemented in adapters/session.ts; the app layer depends only on this interface.
 */
export interface RelaySessionService extends RelayDeviceKeySessionOperations {
  /** Identity mode this service was built for; the HTTP layer accepts only that mode's body. */
  readonly mode: "zai-jwt" | "device-key";
  /** Verifies the account identity token and mints a relay JWT, or returns undefined. zai-jwt mode only. */
  exchange(identityToken: string): RelaySession | undefined;
  /** Returns the relay user id for a valid relay JWT, or undefined. */
  verify(jwt: string): string | undefined;
}

export interface RelayPeer {
  send(message: WebRemoteControlRelayV2IncomingMessage | Record<string, unknown>): boolean;
  close(): void;
}

import type { RelayLogger } from "./domain/logger.js";

export type { RelayLogger } from "./domain/logger.js";
export type {
  RelaySession,
  RelayDeviceKeyExchange,
  RelayDeviceKeyResult,
  RelayDeviceKeySessionOperations,
  RelayDeviceKeyStore,
} from "./deviceKeyContract.js";

export interface RelayServerOptions {
  store: RelayDeviceStore;
  session: RelaySessionService;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  trustedProxies?: readonly string[];
  maxConnections?: number;
  registrationsPerMinute?: number;
  maxBufferedBytes?: number;
  maxTotalBufferedBytes?: number;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  logger?: RelayLogger;
  now?: () => number;
}

export interface RelayServer {
  url: string;
  close(): Promise<void>;
}

export type RelayDeviceView = WebRemoteControlRelayV2Device;
export type RelayRole = WebRemoteControlRelayV2Role;
