import { z } from "zod";

export const RELAY_MAX_MESSAGE_BYTES = 1024 * 1024;
export const RELAY_MAX_CONTROL_BYTES = 4096;
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/u);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const role = z.enum(["device", "terminal"]);
const pairStatus = z.enum(["waiting", "matched"]);
const errorCode = z.enum(["AUTH_FAILED", "DEVICE_OFFLINE", "KICKED", "WRONG_PARAM", "INTERNAL"]);
const meta = z.object({
  platform: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
}).strict();

const registration = z.object({
  type: z.literal("device_register_init"),
  device_mid: identifier,
  pass_hash: z.string().min(1).max(128),
  meta,
  client_ts: timestamp,
}).strict();
const authInit = z.object({
  type: z.literal("auth_init"), role, device_sid: identifier, meta, client_ts: timestamp,
}).strict();
const authResponse = z.object({
  type: z.literal("auth_response"), device_sid: identifier,
  proof: z.string().min(1).max(128), client_ts: timestamp,
}).strict();
const pairQuery = z.object({
  type: z.literal("pair_status_query"), device_sid: identifier, client_ts: timestamp,
}).strict();
const data = z.object({
  type: z.literal("data"), payload: z.unknown().refine(value => value !== undefined),
  client_ts: timestamp, server_ts: timestamp,
}).strict();

export const relayClientMessageSchema = z.discriminatedUnion("type", [
  registration, authInit, authResponse, pairQuery, data,
]);
export type RelayClientMessage = z.infer<typeof relayClientMessageSchema>;

const registerAck = z.object({
  type: z.literal("device_register_ack"), device_sid: identifier, server_ts: timestamp,
}).strict();
const authChallenge = z.object({
  type: z.literal("auth_challenge"), nonce: identifier, server_ts: timestamp,
}).strict();
const authAck = z.object({
  type: z.literal("auth_ack"), device_sid: identifier, terminal_sid: identifier.optional(),
  pair_status: pairStatus, server_ts: timestamp,
}).strict();
const pairAck = z.object({
  type: z.literal("pair_status_ack"), terminal_sid: identifier.optional(),
  pair_status: pairStatus, server_ts: timestamp,
}).strict();
const relayError = z.object({
  type: z.literal("error"), code: errorCode, message: z.string().max(256), server_ts: timestamp,
}).strict();
export const relayServerMessageSchema = z.discriminatedUnion("type", [
  registerAck, authChallenge, authAck, pairAck, data, relayError,
]);
export type RelayServerMessage = z.infer<typeof relayServerMessageSchema>;

export type WebRemoteControlRelayDeviceMeta = z.infer<typeof meta>;
export type WebRemoteControlRelayRole = z.infer<typeof role>;
export type WebRemoteControlRelayPairStatus = z.infer<typeof pairStatus>;
export type WebRemoteControlRelayErrorCode = z.infer<typeof errorCode>;
export interface WebRemoteControlRelayOutgoingBase { client_ts?: number; }
export interface WebRemoteControlRelayIncomingBase { server_ts?: number; }
export type WebRemoteControlRelayDeviceRegisterInit = z.infer<typeof registration>;
export type WebRemoteControlRelayDeviceRegisterAck = z.infer<typeof registerAck>;
export type WebRemoteControlRelayAuthInit = z.infer<typeof authInit>;
export type WebRemoteControlRelayAuthChallenge = z.infer<typeof authChallenge>;
export type WebRemoteControlRelayAuthResponse = z.infer<typeof authResponse>;
export type WebRemoteControlRelayAuthAck = z.infer<typeof authAck>;
export type WebRemoteControlRelayPairStatusQuery = z.infer<typeof pairQuery>;
export type WebRemoteControlRelayPairStatusAck = z.infer<typeof pairAck>;
export type WebRemoteControlRelayError = z.infer<typeof relayError>;
export interface WebRemoteControlRelayDataMessage<TPayload = unknown>
  extends WebRemoteControlRelayOutgoingBase, WebRemoteControlRelayIncomingBase {
  type: "data";
  payload: TPayload;
}

export interface WebRemoteControlRelayAuthProofVector {
  passHash: string;
  nonce: string;
  role: WebRemoteControlRelayRole;
  deviceSid: string;
  proof: string;
}
export const WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS: WebRemoteControlRelayAuthProofVector[] = [
  { passHash: "dGVzdF9oYXNo", nonce: "nonce-1", role: "device", deviceSid: "device-1",
    proof: "XK0m7u-26VS88uk7ISAX5Z_9pjzq8jqyP77N-HkCsPE" },
  { passHash: "dGVzdF9oYXNo", nonce: "nonce-1", role: "terminal", deviceSid: "device-1",
    proof: "YkqkJy-p-iZK1g1AcoGd0Q83REOggX1EygWkcxW4oLU" },
];
