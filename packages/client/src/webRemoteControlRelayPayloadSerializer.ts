import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { type WebRemoteControlRelayV2OutgoingData } from "@zcode/shared/web-remote-relay";

export type WebRemoteControlPayloadSendResult =
  | { kind: "sent"; bytes: number }
  | { kind: "unavailable" }
  | { kind: "oversize"; bytes: number; maxBytes: number };

export interface SerializedWebRemoteControlRelayPayload {
  readonly message: Omit<WebRemoteControlRelayV2OutgoingData, "payload"> & {
    payload: WebRemoteControlAppPayload;
  };
  readonly json: string;
  readonly bytes: number;
}

/**
 * Pin a single final relay JSON per immutable app payload.
 *
 * Bugfix: the old path called Date.now()/JSON.stringify separately at meter and send time, so
 * replay accounting did not record the bytes actually written to the WebSocket. The WeakMap ties
 * the cache lifetime to the frame held by the adapter; once a cumulative ACK releases the frame
 * it becomes GC-eligible, avoiding a second replay owner.
 */
export class WebRemoteControlRelayPayloadSerializer {
  private readonly cache = new WeakMap<object, SerializedWebRemoteControlRelayPayload>();

  prepare(
    payload: WebRemoteControlAppPayload,
    clientTimestamp = Date.now(),
  ): SerializedWebRemoteControlRelayPayload {
    const cached = this.cache.get(payload);
    if (cached) return cached;
    const message: Omit<WebRemoteControlRelayV2OutgoingData, "payload"> & {
      payload: WebRemoteControlAppPayload;
    } = {
      type: "data",
      payload,
      client_ts: clientTimestamp,
    };
    const json = JSON.stringify(message);
    const prepared = Object.freeze({
      message,
      json,
      bytes: new TextEncoder().encode(json).byteLength,
    });
    this.cache.set(payload, prepared);
    return prepared;
  }

  isOversize(prepared: SerializedWebRemoteControlRelayPayload): boolean {
    return prepared.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes;
  }
}
