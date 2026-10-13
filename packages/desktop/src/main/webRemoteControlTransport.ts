/* eslint-disable max-lines -- the external relay transport needs to centrally maintain the handshake, pairing, heartbeat, and reconnection state machines. */
import { WebSocket, type RawData } from "ws";
import { createHash } from "node:crypto";
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS,
  getWebRemoteControlHeartbeatDelayMs,
  getWebRemoteControlHeartbeatJitterMs,
  getWebRemoteControlReconnectJitterMs,
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  parseWebRemoteControlAppPayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlRelayDeviceMeta,
  type WebRemoteControlRelayIncomingMessage,
  type WebRemoteControlRelayOutgoingMessage,
} from "@zcode/shared";
import type { WebRemoteControlRelayAuthProvider } from "./webRemoteControlRelayAuthProvider.js";
import {
  noteWebRemoteRelayConnectAttempt,
  noteWebRemoteRelayReconnect,
} from "./desktopNetworkTelemetry.js";

export type WebRemoteControlDeviceTransportState =
  | "idle"
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "kicked"
  | "error";

export type WebRemoteControlDeviceTransportAuth =
  | {
      mode: "register";
      passHash: string;
    }
  | {
      mode: "persisted";
      deviceSid: string;
      passHash: string;
    };

export interface WebRemoteControlDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  auth: WebRemoteControlDeviceTransportAuth;
  meta: WebRemoteControlRelayDeviceMeta;
  authProvider: WebRemoteControlRelayAuthProvider;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  reconnectDelayMs?: number;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onStateChange(state: WebRemoteControlDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  onInvalidPersistedAuth(): Promise<void>;
}

function parseRelayMessage(raw: RawData): WebRemoteControlRelayIncomingMessage | null {
  // Bugfix: the hard gate must be applied to the uncompressed raw bytes before JSON.parse/string copying; WebSocket compression
  // only affects on-the-wire bytes and must not let an over-limit decompressed app payload reach the parser.
  if (estimateRawDataBytes(raw) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
    return null;
  }
  try {
    const bytes = Array.isArray(raw)
      ? Buffer.concat(raw)
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          : Buffer.from(String(raw), "utf8");
    const parsed = JSON.parse(bytes.toString("utf8")) as WebRemoteControlRelayIncomingMessage;
    return parsed && typeof parsed === "object" && "type" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

function safePayloadMetadata(payload: unknown): Record<string, string | undefined> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    zcode_type: typeof record.zcode_type === "string" ? record.zcode_type : undefined,
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    bridgeSessionId:
      typeof record.bridgeSessionId === "string" ? record.bridgeSessionId : undefined,
  };
}

function isRawTransportCandidate(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

function estimateRawDataBytes(raw: RawData): number {
  if (Array.isArray(raw)) {
    return raw.reduce((total, part) => total + part.byteLength, 0);
  }
  if (typeof raw === "string") {
    return Buffer.byteLength(raw, "utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  if (ArrayBuffer.isView(raw)) {
    return raw.byteLength;
  }
  return Buffer.byteLength(String(raw), "utf8");
}

function summarizeRelayMessageForTrace(
  message: WebRemoteControlRelayIncomingMessage | WebRemoteControlRelayOutgoingMessage,
): Record<string, unknown> {
  if (message.type === "pair_status_ack") {
    return { type: message.type, pair_status: message.pair_status };
  }
  if (message.type === "auth_init") {
    return { type: message.type, role: message.role };
  }
  if (message.type === "data") {
    const payload = message.payload;
    const seq =
      payload && typeof payload === "object" && !Array.isArray(payload) && "seq" in payload
        ? (payload as { seq?: unknown }).seq
        : undefined;
    return {
      type: message.type,
      payload: safePayloadMetadata(message.payload),
      ...(typeof seq === "number" ? { seq } : {}),
    };
  }
  if (message.type === "error") {
    return { type: message.type, code: message.code };
  }
  return { type: message.type };
}

function createMessageHashFromRaw(raw: RawData): string {
  const bytes =
    typeof raw === "string"
      ? Buffer.from(raw, "utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          : Buffer.from(String(raw), "utf8");
  return createHash("sha1").update(bytes).digest("hex").slice(0, 16);
}

function createMessageHashFromText(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
}

export class WebRemoteControlDeviceTransport {
  private socket?: WebSocket;
  private state: WebRemoteControlDeviceTransportState = "idle";
  private activeAuth: WebRemoteControlDeviceTransportAuth;
  private deviceSid?: string;
  private manuallyClosed = false;
  private terminalClose = false;
  private invalidPersistedRetryUsed = false;
  private suppressNextCloseReconnect = false;
  private wasPaired = false;
  private staleWaitingCount = 0;
  private lastPairStatusAckAt = 0;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAckWatchdogTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private staleWaitingRecoveryTimer?: ReturnType<typeof setTimeout>;
  // Bugfix: relay message trace also writes to logs/web-remote-control at message-stream frequency in dev mode.
  // It is now fully off by default, avoiding high-frequency disk writes and leftover sensitive summaries while
  // debugging locally; restoring it requires updating the logging spec first.
  private readonly traceRelayMessages = false;
  private connectStartedAt = 0;
  private connectAttempt = 0;
  private socketGeneration = 0;
  private lastPairedSocketGeneration = 0;
  private readonly payloadSerializer = new WebRemoteControlRelayPayloadSerializer();

  constructor(private readonly options: WebRemoteControlDeviceTransportOptions) {
    this.activeAuth = options.auth;
    this.deviceSid = options.auth.mode === "persisted" ? options.auth.deviceSid : undefined;
  }

  start(): void {
    this.manuallyClosed = false;
    this.terminalClose = false;
    this.wasPaired = false;
    this.lastPairedSocketGeneration = 0;
    this.staleWaitingCount = 0;
    this.lastPairStatusAckAt = 0;
    this.connect();
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.payloadSerializer.prepare(payload).bytes;
  }

  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    const prepared = this.payloadSerializer.prepare(payload);
    if (this.payloadSerializer.isOversize(prepared)) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    if (this.state !== "paired" || this.staleWaitingCount > 0) {
      return { kind: "unavailable" };
    }
    return this.sendSerialized(prepared.message, prepared.json)
      ? { kind: "sent", bytes: prepared.bytes }
      : { kind: "unavailable" };
  }

  dispose(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.socket?.close();
    this.socket = undefined;
    this.setState("idle");
  }

  private connect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.connectAttempt += 1;
    this.socketGeneration += 1;
    this.connectStartedAt = Date.now();
    this.setState("connecting");
    this.lastPairStatusAckAt = Date.now();
    this.options.logger.info("[web-remote-control] external relay device connecting");

    const relayUrl = new URL(this.options.relayWsUrl);
    // Bugfix: testing showed the external relay's edge layer may shard only by query.mid; relying on
    // X-Device-ID alone can land desktop and phone on different backends, leaving both stuck in waiting.
    relayUrl.searchParams.set("mid", this.options.deviceMid);

    const socket = new WebSocket(relayUrl.toString(), {
      // Bugfix: negotiate permessage-deflate first when the relay supports it, reducing network transfer
      // overhead for large rpc-frames.
      // When the server doesn't support it, it falls back to uncompressed automatically, without affecting
      // protocol semantics or data integrity.
      perMessageDeflate: true,
      headers: {
        "X-Device-ID": this.options.deviceMid,
      },
    });
    this.socket = socket;

    socket.on("open", () => {
      if (socket !== this.socket) {
        return;
      }
      const negotiatedExtensions = typeof socket.extensions === "string" ? socket.extensions : "";
      this.options.logger.info("[web-remote-control] external relay negotiated extensions", {
        perMessageDeflate: negotiatedExtensions.includes("permessage-deflate"),
        extensions: negotiatedExtensions || undefined,
      });
      if (this.activeAuth.mode === "register") {
        this.setState("registering");
        this.send({
          type: "device_register_init",
          device_mid: this.options.deviceMid,
          pass_hash: this.activeAuth.passHash,
          meta: this.options.meta,
          client_ts: Date.now(),
        });
        return;
      }

      this.sendAuthInit(this.activeAuth.deviceSid);
    });

    socket.on("message", (raw) => {
      // Bugfix: during a jitter-delayed reconnect the old socket may still deliver queued events; only process
      // the current socket,
      // avoiding stale ACK/data rewriting the new connection's state or entering the business layer.
      if (socket !== this.socket) {
        return;
      }
      if (
        estimateRawDataBytes(raw) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
      ) {
        this.options.logger.warn("[web-remote-control] oversize external relay message dropped", {
          bytes: estimateRawDataBytes(raw),
          maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
        });
        this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
        return;
      }
      const message = parseRelayMessage(raw);
      if (!message) {
        this.options.logger.warn("[web-remote-control] invalid external relay message");
        return;
      }
      this.logRelayTrace("recv", {
        ...summarizeRelayMessageForTrace(message),
        bytes: estimateRawDataBytes(raw),
        // Bugfix: bytes alone previously couldn't distinguish "the same frame resent" from "different frames
        // of the same size".
        // A short hash in dev mode makes it quick to locate the source of duplicate transmissions.
        contentHash: createMessageHashFromRaw(raw),
      });
      void this.handleMessage(message);
    });

    socket.on("error", (error) => {
      if (socket !== this.socket) {
        return;
      }
      this.options.logger.warn("[web-remote-control] external relay device socket error", {
        message: error.message,
      });
      noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, false, {
        error,
        attempt: this.connectAttempt,
      });
      this.options.onError(error);
    });

    socket.on("close", () => {
      if (socket !== this.socket) {
        return;
      }
      this.stopHeartbeat();
      if (this.suppressNextCloseReconnect) {
        this.suppressNextCloseReconnect = false;
        return;
      }
      if (!this.manuallyClosed && !this.terminalClose) {
        this.options.logger.warn("[web-remote-control] external relay device disconnected");
        if (this.state !== "paired") {
          noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, false, {
            attempt: this.connectAttempt,
          });
        }
        noteWebRemoteRelayReconnect();
        this.scheduleReconnect();
      }
    });
  }

  private async handleMessage(message: WebRemoteControlRelayIncomingMessage): Promise<void> {
    switch (message.type) {
      case "device_register_ack": {
        this.deviceSid = message.device_sid;
        if (this.activeAuth.mode === "register") {
          this.options.onRegisteredAuth({
            deviceSid: message.device_sid,
            passHash: this.activeAuth.passHash,
          });
          // Bugfix: after the first successful registration, later relay reconnects within the same transport
          // must not keep using register.
          // Otherwise an already-paired session that hits a brief waiting would re-register the device,
          // invalidating the sid in the old QR code, and the phone couldn't reconnect even after a refresh.
          this.activeAuth = {
            mode: "persisted",
            deviceSid: message.device_sid,
            passHash: this.activeAuth.passHash,
          };
        }
        this.sendAuthInit(message.device_sid);
        break;
      }
      case "auth_challenge": {
        if (!this.deviceSid) {
          this.enterError(new Error("External relay auth challenge arrived before device_sid"));
          return;
        }
        this.send({
          type: "auth_response",
          device_sid: this.deviceSid,
          proof: this.options.authProvider.calculateProof(
            this.activeAuth.passHash,
            message.nonce,
            "device",
            this.deviceSid,
          ),
          client_ts: Date.now(),
        });
        break;
      }
      case "auth_ack":
      case "pair_status_ack": {
        this.applyPairStatus(message.pair_status);
        break;
      }
      case "data": {
        this.handleDataPayload(message.payload);
        break;
      }
      case "error": {
        await this.handleRelayError(message.code, message.message);
        break;
      }
    }
  }

  private sendAuthInit(deviceSid: string): void {
    this.deviceSid = deviceSid;
    this.setState("authenticating");
    this.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: this.options.meta,
      client_ts: Date.now(),
    });
  }

  private applyPairStatus(status: "waiting" | "matched"): void {
    // Bugfix: after sleep/wake the WebSocket can be half-open (not closed locally, already reclaimed by the
    // relay).
    // As long as pair_status_ack still arrives, update the latest heartbeat ack time; the heartbeat timeout
    // guard later decides whether to reconnect.
    this.lastPairStatusAckAt = Date.now();
    this.armHeartbeatAckWatchdog();
    if (status === "waiting") {
      if (this.wasPaired) {
        // Bugfix: the relay occasionally reports one heartbeat ACK of an already-paired session as waiting.
        // The first waiting enters a "recoverable suspect state" (staleWaitingCount>0; sendPayload pauses
        // business sends),
        // avoiding the desktop immediately degrading to waiting_terminal while the phone keeps requesting as
        // paired, tearing the two ends' states apart.
        this.staleWaitingCount += 1;
        this.startHeartbeat();
        if (this.staleWaitingCount === 1) {
          this.scheduleStaleWaitingRecovery();
          return;
        }
        this.reconnectAfterStaleWaiting();
        return;
      }
      // Bugfix: the relay may also reclaim the connection by idle timeout during waiting_terminal.
      // Keep sending pair_status_query as lightweight keep-alive here, avoiding the desktop passively
      // disconnecting every minute before the phone has scanned the QR code.
      this.setState("waiting_terminal");
      this.startHeartbeat();
      return;
    }
    if (status === "matched") {
      const previousPairedGeneration = this.lastPairedSocketGeneration;
      const sendReadyKind =
        previousPairedGeneration === 0
          ? null
          : previousPairedGeneration === this.socketGeneration
            ? "same-socket"
            : "reconnected-socket";
      this.staleWaitingCount = 0;
      this.clearStaleWaitingRecoveryTimer();
      this.setState("paired");
      this.wasPaired = true;
      this.lastPairedSocketGeneration = this.socketGeneration;
      this.startHeartbeat();
      if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
      return;
    }
  }

  private async handleRelayError(
    code: "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL",
    message: string,
  ): Promise<void> {
    if (code === "KICKED") {
      // Bugfix: the business meaning of KICKED is that only one phone terminal may exist per remote-control
      // link.
      // The desktop device side can also briefly receive this error when rebuilding the socket after a
      // heartbeat timeout; the desktop remote-control runtime must not be shut down because of it.
      this.options.logger.warn("[web-remote-control] external relay device KICKED, reconnecting", {
        message,
      });
      this.socket?.close();
      return;
    }

    if (
      code === "AUTH_FAILED" &&
      this.activeAuth.mode === "persisted" &&
      !this.invalidPersistedRetryUsed
    ) {
      this.invalidPersistedRetryUsed = true;
      await this.options.onInvalidPersistedAuth();
      this.activeAuth = {
        mode: "register",
        passHash: this.activeAuth.passHash,
      };
      this.deviceSid = undefined;
      this.suppressNextCloseReconnect = true;
      this.socket?.close();
      this.scheduleReconnect(0);
      return;
    }

    if (code === "INTERNAL") {
      if (this.state === "paired" || this.state === "waiting_terminal") {
        this.enterWaitingForPairAfterRelayError(new Error(message || code));
        return;
      }
      // Bugfix: the external relay may briefly return INTERNAL when a terminal refreshes/reconnects quickly.
      // Such errors don't mean the user ended the pairing; terminalClose must not be set, otherwise there
      // would be no automatic reconnect after close.
      this.enterRecoverableError(new Error(message || code));
      return;
    }

    if (code === "WRONG_PARAM" && (this.state === "paired" || this.state === "waiting_terminal")) {
      this.options.onError(new Error(message || code));
      return;
    }

    this.enterError(new Error(message || code));
  }

  private handleDataPayload(payload: unknown): void {
    if (this.state !== "paired") {
      return;
    }

    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) {
      return;
    }
    const parsed = parseWebRemoteControlAppPayload(payload);
    if (!parsed) {
      this.options.logger.warn("[web-remote-control] invalid external relay payload dropped", {
        ...safePayloadMetadata(payload),
      });
      return;
    }

    this.options.onPayload(parsed);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.armHeartbeatAckWatchdog();
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(
      () => {
        this.heartbeatTimer = undefined;
        if (!this.deviceSid || (this.state !== "paired" && this.state !== "waiting_terminal")) {
          return;
        }
        this.send({
          type: "pair_status_query",
          device_sid: this.deviceSid,
          client_ts: Date.now(),
        });
        // Bugfix: a fixed setInterval makes devices paired at the same time send heartbeats in phase
        // indefinitely;
        // re-sampling bounded jitter after each send only scatters the scheduling phase and doesn't change
        // the average 10-second period.
        this.scheduleHeartbeat();
      },
      getWebRemoteControlHeartbeatDelayMs(
        this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
        this.options.heartbeatJitterMs,
      ),
    );
  }

  private armHeartbeatAckWatchdog(): void {
    if (this.state !== "paired" && this.state !== "waiting_terminal") {
      return;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
    }
    this.heartbeatAckWatchdogTimer = setTimeout(() => {
      this.heartbeatAckWatchdogTimer = undefined;
      if (this.state !== "paired" && this.state !== "waiting_terminal") {
        return;
      }
      // Bugfix: the ACK deadline must be independent of the next jittered heartbeat; otherwise random
      // intervals drift
      // what should be a 30-second loss detection to 32-36 seconds, and keep black-holing sends on a
      // half-open socket.
      const staleMs = Date.now() - this.lastPairStatusAckAt;
      this.options.logger.warn(
        "[web-remote-control] external relay heartbeat ack timeout, reconnecting",
        { state: this.state, staleMs },
      );
      this.reconnectAfterStaleWaiting(this.getReconnectJitterMs());
    }, this.options.heartbeatAckTimeoutMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS);
  }

  private getReconnectJitterMs(): number {
    const baseIntervalMs =
      this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS;
    const heartbeatJitterMs = getWebRemoteControlHeartbeatJitterMs(
      baseIntervalMs,
      this.options.heartbeatJitterMs,
    );
    return getWebRemoteControlReconnectJitterMs(
      this.options.reconnectJitterMs ??
        Math.min(heartbeatJitterMs, WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS),
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
      this.heartbeatAckWatchdogTimer = undefined;
    }
  }

  private scheduleReconnect(delayMs = this.options.reconnectDelayMs ?? 1_000): void {
    if (this.manuallyClosed || this.terminalClose) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleStaleWaitingRecovery(): void {
    if (this.staleWaitingRecoveryTimer) {
      return;
    }
    // Bugfix: the production heartbeat interval is 10 seconds, and the old 1.5-second window would force a
    // reconnect before the next matched confirmation,
    // amplifying a single waiting jitter from the relay into a phone disconnect. Extended to 15 seconds,
    // covering at least one heartbeat round and network jitter.
    this.staleWaitingRecoveryTimer = setTimeout(() => {
      this.staleWaitingRecoveryTimer = undefined;
      if (this.state === "paired" && this.staleWaitingCount > 0) {
        this.reconnectAfterStaleWaiting();
      }
    }, 15_000);
  }

  private clearStaleWaitingRecoveryTimer(): void {
    if (!this.staleWaitingRecoveryTimer) {
      return;
    }
    clearTimeout(this.staleWaitingRecoveryTimer);
    this.staleWaitingRecoveryTimer = undefined;
  }

  private reconnectAfterStaleWaiting(reconnectDelayMs = 0): void {
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    const staleSocket = this.socket;
    this.socket = undefined;
    if (reconnectDelayMs > 0) {
      // Bugfix: during a delayed reconnect the old socket is already unusable; paired must be switched out
      // first so the
      // manager doesn't keep treating this transport as a sendable connection or accept business frames from
      // the old socket.
      this.setState("connecting");
    }
    staleSocket?.close();
    if (reconnectDelayMs > 0) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.manuallyClosed || this.terminalClose) {
          return;
        }
        this.connect();
      }, reconnectDelayMs);
      return;
    }
    this.connect();
  }

  private enterError(error: Error): void {
    this.terminalClose = true;
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("error");
    this.options.onError(error);
    this.socket?.close();
  }

  private enterRecoverableError(error: Error): void {
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("error");
    this.options.onError(error);
    this.socket?.close();
  }

  private enterWaitingForPairAfterRelayError(error: Error): void {
    // Bugfix: when zcode-remote-hub forwards data on an already-authenticated connection but can't find the
    // peer, it only returns INTERNAL
    // without closing the current device WS. "Phone temporarily absent" must not be escalated into a desktop
    // global WS teardown;
    // just pause business sends and keep waiting for the terminal to re-match via pair_status_query.
    this.options.onError(error);
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    this.startHeartbeat();
    this.setState("waiting_terminal");
  }

  private setState(state: WebRemoteControlDeviceTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    if (state === "paired" && previousState !== "paired" && this.connectStartedAt > 0) {
      noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, true, {
        attempt: this.connectAttempt,
      });
    }
    this.options.onStateChange(state);
    if (
      state === "connecting" ||
      state === "registering" ||
      state === "authenticating" ||
      state === "waiting_terminal" ||
      state === "paired" ||
      state === "kicked"
    ) {
      this.options.logger.info("[web-remote-control] external relay device state", { state });
    }
  }

  private send(message: WebRemoteControlRelayOutgoingMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(message);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      this.options.logger.warn("[web-remote-control] outbound relay message exceeds hard limit", {
        type: message.type,
        bytes: serializedBytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      });
      return false;
    }
    return this.sendSerialized(message, serialized);
  }

  private sendSerialized(
    message: WebRemoteControlRelayOutgoingMessage,
    serialized: string,
  ): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    // Bugfix: the send direction previously logged only the message summary without byte size, making it
    // impossible to cross-check against recv's bytes when debugging.
    // Record bytes as the actual UTF-8 text length written to the socket, easing analysis of message-body
    // growth and link anomalies.
    this.logRelayTrace("send", {
      ...summarizeRelayMessageForTrace(message),
      bytes: Buffer.byteLength(serialized, "utf8"),
      contentHash: createMessageHashFromText(serialized),
    });
    this.socket.send(serialized);
    return true;
  }

  private logRelayTrace(direction: "send" | "recv", fields: Record<string, unknown>): void {
    if (!this.traceRelayMessages) {
      return;
    }
    const payload = {
      direction,
      ...fields,
    };
    this.options.logger.info("[web-remote-control][relay-message]", payload);
    this.options.relayMessageLogger?.info(payload);
  }
}
