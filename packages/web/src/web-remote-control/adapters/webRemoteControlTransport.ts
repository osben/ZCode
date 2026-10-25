import type {
  WebRemoteControlTerminalTransportState,
  WebRemoteControlTerminalTransportDiagnostic,
  WebRemoteControlTerminalTransportDiagnosticInput,
  WebRemoteControlTerminalTransportOptions,
} from "#src/web-remote-control/contracts/transport.js";
import {
  webSocketDataByteLength,
  parseRelayMessage,
  createFailure,
  isRawTransportCandidate,
  summarizeRelayMessageForTrace,
} from "#src/web-remote-control/adapters/relayMessage.js";
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  parseWebRemoteControlAppPayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlFailure,
} from "@zcode/shared";
import {
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  WebRemoteControlV2ConnectionError,
  WebRemoteControlV2Heartbeat,
  WebRemoteControlV2RetryPolicy,
  webRemoteControlV2PairState,
  WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS,
  getWebRemoteControlHeartbeatJitterMs,
  getWebRemoteControlReconnectJitterMs,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@zcode/shared/web-remote-relay";

export class WebRemoteControlTerminalTransport {
  private readonly WebSocketCtor: typeof globalThis.WebSocket;
  private socket?: WebSocket;
  private state: WebRemoteControlTerminalTransportState = "idle";
  private intentionallyClosed = false;
  private wasPaired = false;
  private hadPairedSession = false;
  private staleWaitingCount = 0;
  private readonly retry = new WebRemoteControlV2RetryPolicy(Math.random, {
    initialMs: 500,
    maxMs: 10_000,
    jitter: 0,
  });
  private tokenController?: AbortController;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private authenticated = false;
  private readonly heartbeat: WebRemoteControlV2Heartbeat;
  private socketGeneration = 0;
  private lastPairedSocketGeneration = 0;
  private lastPairStatusAckAt = 0;
  private hiddenStartedAt?: number;
  private lastPairStatusDiagnostic?: string;
  private pairedWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private staleWaitingRecoveryTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private desktopOfflineFailureTimer?: ReturnType<typeof setTimeout>;
  private readonly traceRelayMessages = import.meta.env.DEV;
  private readonly payloadSerializer = new WebRemoteControlRelayPayloadSerializer();

  constructor(private readonly options: WebRemoteControlTerminalTransportOptions) {
    this.WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
    this.heartbeat = new WebRemoteControlV2Heartbeat(
      () => this.sendPairStatusQuery(),
      () => this.reconnectAfterStaleWaiting(this.getReconnectJitterMs()),
      {
        intervalMs: options.heartbeatIntervalMs,
        jitterMs: options.heartbeatJitterMs,
        ackTimeoutMs: options.heartbeatAckTimeoutMs,
      },
    );
  }

  start(): void {
    this.intentionallyClosed = false;
    this.wasPaired = false;
    this.hadPairedSession = false;
    this.staleWaitingCount = 0;
    this.retry.acknowledged();
    this.lastPairedSocketGeneration = 0;
    this.lastPairStatusAckAt = Date.now();
    this.setState("connecting");
    this.connect();
  }

  private async connect(): Promise<void> {
    if (this.intentionallyClosed || this.state === "suspended") return;
    const generation = ++this.socketGeneration;
    this.tokenController?.abort();
    const controller = new AbortController();
    this.tokenController = controller;
    this.authenticated = false;
    try {
      const token = await this.options.getToken(controller.signal);
      if (controller.signal.aborted || generation !== this.socketGeneration) return;
      const url = new URL(this.options.relayWsUrl);
      url.searchParams.set("token", token);
      if (this.options.deviceMid?.trim()) {
        url.searchParams.set("mid", this.options.deviceMid);
      }
      const socket = new this.WebSocketCtor(url.toString());
      this.socket = socket;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = setTimeout(
        () => this.scheduleReconnect(),
        WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
      );

      socket.addEventListener("open", () => {
        if (socket !== this.socket) {
          return;
        }
        const negotiatedExtensions = typeof socket.extensions === "string" ? socket.extensions : "";
        // Bugfix: the phone runs under the browser WebSocket API and cannot actively pass a perMessageDeflate configuration.
        // The only way to confirm that the relay actually completed compression negotiation is the standard extensions field, to avoid wrongly assuming business code can force it on.
        this.emitDiagnostic({
          type: "socket-extensions",
          state: this.state,
          perMessageDeflate: negotiatedExtensions.includes("permessage-deflate"),
          ...(negotiatedExtensions ? { extensions: negotiatedExtensions } : {}),
        });
        this.setState("authenticating");
        this.send({
          type: "auth_init",
          device_sid: this.options.deviceSid,
          meta: {
            platform: "web",
            version: this.options.appVersion ?? "web",
            name: "mobile-browser",
          },
          client_ts: Math.floor(Date.now() / 1000),
        });
      });

      socket.addEventListener("message", (event) => {
        if (socket !== this.socket) {
          return;
        }
        void this.handleMessage(event.data, socket);
      });

      socket.addEventListener("error", () => {
        if (socket !== this.socket) {
          return;
        }
        const error = new Error("External relay terminal socket error");
        this.emitDiagnostic({ type: "socket-error", state: this.state });
        this.options.onError(error);
      });

      socket.addEventListener("close", (event) => {
        if (socket !== this.socket) {
          return;
        }
        this.emitDiagnostic({
          type: "socket-close",
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          wasPaired: this.wasPaired,
          state: this.state,
        });
        this.stopHeartbeat();
        this.clearWaitingTimer();
        this.clearStaleWaitingRecoveryTimer();
        if (this.intentionallyClosed) {
          return;
        }
        if (this.state === "suspended") {
          return;
        }
        if (this.hadPairedSession) {
          // Bugfix: phone browser background recovery, network switches, or brief relay jitter close a paired socket.
          // The old logic refreshed the whole page, causing the user to lose the current workspace/task view; it now reconnects in place,
          // so the upper layer restores based on the mobile view state after re-pairing.
          this.scheduleReconnect();
          return;
        }
        this.scheduleReconnect();
      });
    } catch (error) {
      if (controller.signal.aborted || generation !== this.socketGeneration) return;
      if (error instanceof WebRemoteControlV2ConnectionError && !error.retryable) {
        this.enterTerminalFailure(createFailure(error.reason));
      } else this.scheduleReconnect();
    }
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.payloadSerializer.prepare(payload, Math.floor(Date.now() / 1000)).bytes;
  }

  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    const prepared = this.payloadSerializer.prepare(payload, Math.floor(Date.now() / 1000));
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

  suspend(): void {
    if (
      this.state !== "paired" &&
      this.state !== "connecting" &&
      this.state !== "reconnecting" &&
      this.state !== "authenticating" &&
      this.state !== "waiting"
    ) {
      return;
    }
    // An unauthenticated connection has no reusable session, so it is revoked on suspend; a late open/ACK must not start bootstrap in the background.
    if (!this.authenticated) this.closeSocket();
    this.hiddenStartedAt = Date.now();
    this.tokenController?.abort();
    clearTimeout(this.handshakeTimer);
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("suspended");
  }

  async recoverConnection(timeoutMs = 15_000): Promise<void> {
    if (this.intentionallyClosed) throw new Error("Web remote control transport stopped.");
    this.emitDiagnostic({ type: "recover-start", state: this.state });
    this.clearReconnectTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.staleWaitingCount = 0;
    if (
      this.state === "suspended" &&
      this.wasPaired &&
      this.socket?.readyState === this.WebSocketCtor.OPEN
    ) {
      // Bugfix: hidden/pagehide only means the phone page was paused; it does not mean the WebSocket is necessarily broken.
      // First run one pair_status probe on the original socket, so a brief switch to background does not force a disconnect and reconnect.
      this.setState("reconnecting");
      if (this.sendPairStatusQuery()) {
        try {
          await this.waitForPaired(this.options.healthCheckTimeoutMs ?? 3_000);
          return;
        } catch {
          // Rebuild the socket only after the probe times out; do not fail directly here, to avoid mistaking slow brief recovery for a desktop disconnect.
        }
      }
    }
    this.retry.acknowledged();
    this.reconnectNow();
    await this.waitForPaired(timeoutMs);
  }

  recoverInBackground(): void {
    if (this.intentionallyClosed || this.state === "paired" || this.state === "kicked") {
      return;
    }
    // Bugfix: a long background recovery on the phone may exceed recoverConnection's single wait window.
    // Keep reconnecting in place here without switching the current page to an error page, so the draft the user is typing is not unmounted.
    this.clearReconnectTimer();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.stopHeartbeat();
    this.staleWaitingCount = 0;
    this.reconnectNow();
  }

  dispose(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.rejectPairedWaiters(new Error("Web remote control transport disposed."));
    this.closeSocket();
    this.setState("idle");
  }

  private async handleMessage(data: unknown, socket: WebSocket): Promise<void> {
    if (
      webSocketDataByteLength(data) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
      return;
    }
    const message = await parseRelayMessage(data);
    if (!message || socket !== this.socket || this.intentionallyClosed) {
      return;
    }
    this.logRelayTrace("recv", summarizeRelayMessageForTrace(message));

    switch (message.type) {
      case "auth_ack":
        if (this.state !== "authenticating" || message.device_sid !== this.options.deviceSid)
          return;
        this.authenticated = true;
        clearTimeout(this.handshakeTimer);
        this.retry.acknowledged();
        this.applyPairStatus(message.pair_status);
        break;
      case "pair_status_ack":
        if (!this.authenticated || this.state === "suspended") return;
        this.applyPairStatus(message.pair_status);
        break;
      case "data":
        if (!this.authenticated || this.state !== "paired") return;
        this.handleDataPayload(message.payload);
        break;
      case "error":
        this.handleRelayError(message.code, message.message);
        break;
    }
  }

  private applyPairStatus(status: "waiting" | "matched"): void {
    this.lastPairStatusAckAt = Date.now();
    this.emitDiagnostic({ type: "pair-status", pairStatus: status, state: this.state });
    if (webRemoteControlV2PairState(status) === "waiting_terminal") {
      if (this.wasPaired) {
        // Bugfix: zcode-remote-hub's waiting is a legitimate pairing state meaning the current device is not in the hub,
        // and it is not a terminal WS failure signal. When downgraded to waiting after pairing, keep the same phone-side WS,
        // and keep querying lightly, to avoid amplifying a brief desktop reconnect into repeated kicks of the old phone-side connection.
        this.staleWaitingCount = 0;
        this.clearStaleWaitingRecoveryTimer();
        this.clearReconnectTimer();
        this.clearWaitingTimer();
        this.clearDesktopOfflineFailureTimer();
        this.setState("waiting");
        this.startHeartbeat();
        return;
      }
      this.setState("waiting");
      this.startHeartbeat();
      this.startWaitingTimer();
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
      this.retry.acknowledged();
      this.clearStaleWaitingRecoveryTimer();
      this.clearDesktopOfflineFailureTimer();
      this.clearReconnectTimer();
      this.clearWaitingTimer();
      this.setState("paired");
      this.wasPaired = true;
      this.hadPairedSession = true;
      this.lastPairedSocketGeneration = this.socketGeneration;
      this.startHeartbeat();
      if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
      return;
    }
  }

  private handleRelayError(
    code: "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL",
    message?: string,
  ): void {
    if (code === "KICKED") {
      const delay = this.retry.kickedDelay();
      if (delay === null) this.enterTerminalFailure(createFailure("session-conflict"));
      else this.scheduleReconnect({ delayMs: delay });
      return;
    }
    if (code === "DEVICE_OFFLINE") {
      // Bugfix: when the desktop opens remote control or the relay briefly reconnects, the phone may first receive one DEVICE_OFFLINE.
      // The old logic immediately rendered the terminal "desktop offline" page, even though the desktop usually returns to paired within 1-2 seconds.
      // Now it first enters a recoverable reconnect window, and only treats the desktop as truly offline if it is still not paired after the grace period.
      this.recoverFromDeviceOffline(message || code);
      return;
    }
    if (code === "AUTH_FAILED" || code === "WRONG_PARAM") {
      this.enterTerminalFailure(
        createFailure(code === "AUTH_FAILED" ? "device-not-owned" : "invalid-mobile-connection"),
      );
      return;
    }
    if (code === "INTERNAL") {
      if (this.state === "paired" || (this.hadPairedSession && this.state === "waiting")) {
        this.enterWaitingForDeviceAfterRelayError(message || code);
        return;
      }
      // Bugfix: the relay briefly returns INTERNAL when the desktop/phone switch through fast reconnects.
      // Most such errors are recoverable; throwing a failure page directly would force the user to reopen remote control manually, so it now recovers by reconnecting in place.
      this.recoverFromRelayInternal(message || code);
      return;
    }
    this.enterTerminalFailure(createFailure("relay-unavailable", message || code));
  }

  private handleDataPayload(payload: unknown): void {
    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) {
      return;
    }
    const parsed = parseWebRemoteControlAppPayload(payload);
    if (!parsed) {
      return;
    }
    this.options.onPayload(parsed);
  }

  private startHeartbeat(): void {
    this.heartbeat.acknowledged();
  }

  private getReconnectJitterMs(): number {
    const baseIntervalMs =
      this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS;
    const heartbeatJitterMs = getWebRemoteControlHeartbeatJitterMs(
      baseIntervalMs,
      this.options.heartbeatJitterMs,
    );
    return getWebRemoteControlReconnectJitterMs(
      this.options.reconnectJitterMs ??
        Math.min(heartbeatJitterMs, WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS),
    );
  }

  private sendPairStatusQuery(): boolean {
    return this.send({
      type: "pair_status_query",
      client_ts: Math.floor(Date.now() / 1000),
    });
  }

  private stopHeartbeat(): void {
    this.heartbeat.stop();
  }

  private startWaitingTimer(): void {
    if (this.waitingTimer) return;
    this.waitingTimer = setTimeout(() => {
      if (this.state !== "waiting") {
        return;
      }
      this.enterTerminalFailure(
        createFailure(
          "desktop-disconnected",
          "Desktop did not match this mobile connection before the waiting timeout.",
        ),
      );
    }, this.options.waitingTimeoutMs ?? 30_000);
  }

  private clearWaitingTimer(): void {
    if (!this.waitingTimer) {
      return;
    }
    clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  private scheduleStaleWaitingRecovery(): void {
    if (this.staleWaitingRecoveryTimer) {
      return;
    }
    this.staleWaitingRecoveryTimer = setTimeout(() => {
      this.staleWaitingRecoveryTimer = undefined;
      if (
        (this.state === "paired" ||
          this.state === "reconnecting" ||
          this.state === "connecting" ||
          this.state === "authenticating") &&
        this.staleWaitingCount > 0
      ) {
        this.reconnectAfterStaleWaiting();
      }
    }, this.options.staleWaitingRecoveryMs ?? 1_500);
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
    this.clearWaitingTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    // Bugfix: a paired phone may first receive auth_ack: waiting during recovery.
    // wasPaired must not be cleared here, otherwise the next waiting would be treated as a first unmatched state and enter the failure page;
    // keep the paired semantics so the state machine keeps retrying as a recoverable short disconnect until matched.
    if (reconnectDelayMs > 0) {
      this.closeSocket();
      this.setState("reconnecting");
      this.lastPairStatusAckAt = Date.now();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.intentionallyClosed || this.state === "suspended") {
          return;
        }
        this.connect();
      }, reconnectDelayMs);
      return;
    }
    this.reconnectNow();
  }

  private reconnectNow(): void {
    this.closeSocket();
    this.setState("reconnecting");
    this.lastPairStatusAckAt = Date.now();
    this.connect();
  }

  private scheduleReconnect(options?: { immediate?: boolean; delayMs?: number }): void {
    if (this.intentionallyClosed || this.state === "suspended") return;
    if (this.reconnectTimer) {
      return;
    }
    const delayMs = options?.delayMs ?? (options?.immediate ? 0 : this.retry.nextDelay());
    this.closeSocket();
    this.setState("reconnecting");
    this.emitDiagnostic({ type: "recover-scheduled", state: this.state });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionallyClosed || this.state === "suspended") {
        return;
      }
      this.staleWaitingCount = 0;
      this.wasPaired = false;
      this.closeSocket();
      this.connect();
    }, delayMs);
  }

  private recoverFromRelayInternal(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    this.closeSocket();
    this.scheduleReconnect({ immediate: true });
  }

  private recoverFromDeviceOffline(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    if (!this.desktopOfflineFailureTimer) {
      this.desktopOfflineFailureTimer = setTimeout(() => {
        this.desktopOfflineFailureTimer = undefined;
        this.enterTerminalFailure(createFailure("desktop-disconnected", message));
      }, this.options.desktopOfflineGraceMs ?? 15_000);
    }
    this.closeSocket();
    this.scheduleReconnect({ immediate: true });
  }

  private enterWaitingForDeviceAfterRelayError(message: string): void {
    // Bugfix: when zcode-remote-hub forwards data on an authenticated connection and cannot find the device, it only returns INTERNAL,
    // and does not close the current terminal WS. Here the phone-side WS is kept, downgraded to waiting, and pairing status continues to be queried,
    // to avoid amplifying "the desktop is temporarily absent" into repeated phone-side reconnects.
    this.options.onError(new Error(message));
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    this.setState("waiting");
    this.startHeartbeat();
  }

  private clearDesktopOfflineFailureTimer(): void {
    if (!this.desktopOfflineFailureTimer) {
      return;
    }
    clearTimeout(this.desktopOfflineFailureTimer);
    this.desktopOfflineFailureTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private waitForPaired(timeoutMs = 15_000): Promise<void> {
    if (this.state === "paired") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pairedWaiters.delete(waiter);
          reject(new Error("Web remote control relay did not recover before timeout."));
        }, timeoutMs),
      };
      this.pairedWaiters.add(waiter);
    });
  }

  private resolvePairedWaiters(): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.pairedWaiters.clear();
  }

  private rejectPairedWaiters(error: Error): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pairedWaiters.clear();
  }

  private enterTerminalFailure(failure: WebRemoteControlFailure): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.setState(failure.reason === "session-conflict" ? "kicked" : "error");
    this.rejectPairedWaiters(new Error(failure.message ?? failure.reason));
    this.options.onFailure(failure);
    this.closeSocket();
  }

  private closeSocket(): void {
    // A wait timeout belongs to the old socket; KICKED's backoff must not let its leftover reference block the new generation from restarting the timer.
    this.clearWaitingTimer();
    ++this.socketGeneration;
    this.tokenController?.abort();
    this.tokenController = undefined;
    this.authenticated = false;
    clearTimeout(this.handshakeTimer);
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private setState(state: WebRemoteControlTerminalTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    this.emitDiagnostic({
      type: "state-transition",
      previousState,
      state,
    });
    this.options.onStateChange(state);
    if (state === "paired") {
      this.resolvePairedWaiters();
    }
    if (state === "error" || state === "kicked") {
      this.rejectPairedWaiters(new Error(`Web remote control transport entered ${state}.`));
    }
  }

  private send(message: WebRemoteControlRelayV2OutgoingMessage): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(message);
    if (
      new TextEncoder().encode(serialized).byteLength >
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      return false;
    }
    return this.sendSerialized(message, serialized);
  }

  private sendSerialized(
    message: WebRemoteControlRelayV2OutgoingMessage | { type: "data"; payload: unknown },
    serialized: string,
  ): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    this.logRelayTrace("send", summarizeRelayMessageForTrace(message));
    this.socket.send(serialized);
    return true;
  }

  private logRelayTrace(direction: "send" | "recv", fields: Record<string, unknown>): void {
    if (!this.traceRelayMessages) {
      return;
    }
    // Bugfix: remote-control relay message volume is high; printing bodies in production would quickly inflate log size and expose sensitive content.
    // Only summary fields are output in development mode here; that is enough for troubleshooting and does not pollute production logs.
    console.info("[web-remote-control][relay-message]", {
      direction,
      ...fields,
    });
  }

  private emitDiagnostic(diagnostic: WebRemoteControlTerminalTransportDiagnosticInput): void {
    if (diagnostic.type === "pair-status") {
      const nextPairStatusDiagnostic = `${diagnostic.state}:${diagnostic.pairStatus ?? "unknown"}`;
      if (this.lastPairStatusDiagnostic === nextPairStatusDiagnostic) {
        return;
      }
      this.lastPairStatusDiagnostic = nextPairStatusDiagnostic;
    }
    const visibilityState = typeof document === "undefined" ? "unknown" : document.visibilityState;
    const hiddenDurationMs =
      this.hiddenStartedAt && visibilityState !== "hidden"
        ? Date.now() - this.hiddenStartedAt
        : undefined;
    if (hiddenDurationMs !== undefined) {
      this.hiddenStartedAt = undefined;
    }
    this.options.onDiagnostic?.({
      ...diagnostic,
      timestamp: Date.now(),
      visibilityState,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(hiddenDurationMs !== undefined ? { hiddenDurationMs } : {}),
    } as WebRemoteControlTerminalTransportDiagnostic);
  }
}
