import type { RelayServerMessage, WebRemoteControlRelayRole } from "@zcode/shared/web-remote-relay";

export interface RelayRegistration { sid: string; key: string; }
export interface RelayDeviceStore {
  register(mid: string, key: string): Promise<RelayRegistration>;
  get(sid: string): Promise<RelayRegistration | undefined>;
  close(): Promise<void>;
}
export interface RelayCrypto {
  randomId(): string;
  verify(key: string, nonce: string, role: WebRemoteControlRelayRole, sid: string, proof: string): boolean;
}
export interface RelayPeer {
  send(message: RelayServerMessage, serialized?: string): boolean;
  close(): void;
}
export interface RelayLogger {
  info(event: string): void;
  warn(event: string): void;
  error(event: string): void;
}
export interface RelayServerOptions {
  store: RelayDeviceStore;
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
