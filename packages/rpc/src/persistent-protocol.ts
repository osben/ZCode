/**
 * PersistentProtocol — reliability layer (split from protocol.ts to keep the file within size limits).
 *
 * Adds the following over SocketProtocol:
 * - Message ACK mechanism
 * - Keep-alive heartbeat
 * - Replay of unacknowledged messages after reconnection (bounded by bytes and a time grace window)
 * - Congestion signals: unacknowledgedBytes watermark + onSaturated/onDrained
 *   (the only new frame-level to event-level interface: event-level code pauses
 *   drain accordingly; dropping/degradation always happens at the channel layer, before RPC, and frames accepted by send() are never dropped)
 *
 * The key point: the Channel RPC layer does not know PersistentProtocol exists;
 * it sees only the IMessagePassingProtocol interface. This is the benefit of layered abstractions.
 */

import { VSBuffer } from "./buffer.js";
import { Emitter, DisposableStore } from "./foundation.js";
import {
  ChunkStream,
  HEADER_SIZE,
  ProtocolMessage,
  ProtocolMessageType,
  writeProtocolMessage,
  type ConnectionFlowControl,
  type IMessagePassingProtocol,
  type ISocket,
} from "./protocol.js";

/** Tunable PersistentProtocol options (v4 channel-layer patch). */
export interface PersistentProtocolOptions {
  /** Unacknowledged-byte high watermark: crossing it triggers onSaturated (higher layers pause drain and let coalescing absorb events). */
  saturationHighWaterMarkBytes?: number;
  /** Unacknowledged-byte low watermark: after saturation, falling to this level triggers onDrained (higher layers resume drain). */
  saturationLowWaterMarkBytes?: number;
  /** Replay buffer byte limit: exceeding it abandons the protocol session (onClose), and the client recovers via subscribe(base). */
  replayBufferMaxBytes?: number;
  /** Replay buffer time grace window (ms): the session is also abandoned if the oldest unacknowledged message exceeds it. */
  replayBufferGraceMs?: number;
}

interface UnackEntry {
  msg: ProtocolMessage;
  queuedAt: number;
}

export class PersistentProtocol implements IMessagePassingProtocol, ConnectionFlowControl {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  private readonly _onClose = new Emitter<void>();
  readonly onClose = this._onClose.event;

  private readonly _onSocketClose = new Emitter<void>();
  readonly onSocketClose = this._onSocketClose.event;

  // Congestion signals: reaching the high watermark triggers onSaturated; falling to the low watermark triggers onDrained.
  private readonly _onSaturated = new Emitter<void>();
  readonly onSaturated = this._onSaturated.event;

  private readonly _onDrained = new Emitter<void>();
  readonly onDrained = this._onDrained.event;

  private socket: ISocket;
  private chunkStream = new ChunkStream();
  private disposables = new DisposableStore();

  // ACK mechanism (bounded queue; entries include enqueue time for grace-window checks)
  private outgoingMsgId = 0;
  private outgoingUnackMsg: UnackEntry[] = [];
  private incomingAckId = 0;
  private unackBytes = 0;
  private saturated = false;
  private overflowed = false;

  // Heartbeat
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly KEEP_ALIVE_INTERVAL = 5000; // 5 seconds

  // ACK timeout
  private ackCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ACK_TIMEOUT = 20000; // Disconnect after 20 seconds without an ACK.
  private lastAckTime = Date.now();

  // Default watermarks/limits: 1 MiB high watermark (approximately the v4 single-frame limit), low watermark at one quarter of the high watermark;
  // replay buffer is 8 MiB / 45s. Abandon the session if the peer is screen-locked or stops ACKing for a long time instead of buffering indefinitely.
  private readonly saturationHighWaterMarkBytes: number;
  private readonly saturationLowWaterMarkBytes: number;
  private readonly replayBufferMaxBytes: number;
  private readonly replayBufferGraceMs: number;

  constructor(socket: ISocket, options: PersistentProtocolOptions = {}) {
    this.saturationHighWaterMarkBytes = options.saturationHighWaterMarkBytes ?? 1024 * 1024;
    this.saturationLowWaterMarkBytes =
      options.saturationLowWaterMarkBytes ?? Math.floor(this.saturationHighWaterMarkBytes / 4);
    this.replayBufferMaxBytes = options.replayBufferMaxBytes ?? 8 * 1024 * 1024;
    this.replayBufferGraceMs = options.replayBufferGraceMs ?? 45_000;
    this.socket = socket;
    this.bindSocket();
    this.startKeepAlive();
    this.startAckCheck();
  }

  /** Current payload bytes not yet ACKed by the peer (read-only congestion metric). */
  get unacknowledgedBytes(): number {
    return this.unackBytes;
  }

  private bindSocket(): void {
    this.disposables.add(
      this.socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        this.readMessages();
      }),
    );

    this.disposables.add(
      this.socket.onClose(() => {
        this._onSocketClose.fire();
      }),
    );
  }

  send(buffer: VSBuffer): void {
    const msg = new ProtocolMessage(
      ProtocolMessageType.Regular,
      ++this.outgoingMsgId,
      this.incomingAckId,
      buffer,
    );
    this.outgoingUnackMsg.push({ msg, queuedAt: Date.now() });
    this.unackBytes += buffer.byteLength;
    this.writeMessage(msg);
    // Replay buffer byte limit exceeded → abandon the session immediately (synchronous check; do not wait for a timer).
    if (this.unackBytes > this.replayBufferMaxBytes) {
      this.abandonSession();
      return;
    }
    // Crossing the high watermark enters the saturated state (edge-triggered; no duplicate notifications).
    if (!this.saturated && this.unackBytes > this.saturationHighWaterMarkBytes) {
      this.saturated = true;
      this._onSaturated.fire();
    }
  }

  /**
   * Replace the underlying socket on reconnection and replay all unacknowledged messages.
   * This is why Remote mode does not lose messages after reconnecting.
   */
  replaceSocket(newSocket: ISocket): void {
    this.disposables.dispose();
    this.disposables = new DisposableStore();
    this.chunkStream = new ChunkStream();
    this.socket = newSocket;
    this.bindSocket();

    // Replay unacknowledged messages.
    for (const entry of this.outgoingUnackMsg) {
      this.writeMessage(entry.msg);
    }
  }

  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  private readMessages(): void {
    while (true) {
      if (this.chunkStream.byteLength < HEADER_SIZE) {
        break;
      }

      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      const type = header.readUInt8(0) as ProtocolMessageType;
      const id = header.readUInt32BE(1);
      const ack = header.readUInt32BE(5);
      const length = header.readUInt32BE(9);

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // PersistentProtocol and SocketProtocol both use stream transports,
        // so wait for the complete frame before consuming its header here too; otherwise fragmentation can consume the header prematurely.
        break;
      }

      this.chunkStream.skip(HEADER_SIZE);

      let body = VSBuffer.alloc(0);
      if (length > 0) {
        const readBody = this.chunkStream.read(length);
        if (!readBody) {
          throw new Error("PersistentProtocol 读取到完整帧长度后 body 不应为空");
        }
        body = readBody;
      }

      // Process the peer's ACK and clear acknowledged messages from the send queue.
      this.processAck(ack);

      switch (type) {
        case ProtocolMessageType.Regular:
          this.incomingAckId = id;
          this._onMessage.fire(body);
          break;
        case ProtocolMessageType.Ack:
          // ACK-only message; update the acknowledgment number.
          break;
        case ProtocolMessageType.KeepAlive:
          // Heartbeat; update only the last-active time.
          break;
        case ProtocolMessageType.Disconnect:
          this._onClose.fire();
          break;
      }

      this.lastAckTime = Date.now();
    }
  }

  /** Clear messages acknowledged by the peer's ACK number. */
  private processAck(ack: number): void {
    while (this.outgoingUnackMsg.length > 0 && this.outgoingUnackMsg[0].msg.id <= ack) {
      const entry = this.outgoingUnackMsg.shift()!;
      this.unackBytes -= entry.msg.data.byteLength;
    }
    // Falling to the low watermark after saturation triggers onDrained (edge-triggered).
    if (this.saturated && this.unackBytes <= this.saturationLowWaterMarkBytes) {
      this.saturated = false;
      this._onDrained.fire();
    }
  }

  /**
   * Replay buffer limit exceeded (bytes/grace window): this protocol session can no longer resume losslessly.
   * Disconnect through onClose so the client can recover at the semantic layer with subscribe(base).
   */
  private abandonSession(): void {
    if (this.overflowed) {
      return;
    }
    this.overflowed = true;
    this.writeMessage(
      new ProtocolMessage(ProtocolMessageType.Disconnect, 0, this.incomingAckId, VSBuffer.alloc(0)),
    );
    this._onClose.fire();
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      this.writeMessage(
        new ProtocolMessage(
          ProtocolMessageType.KeepAlive,
          0,
          this.incomingAckId,
          VSBuffer.alloc(0),
        ),
      );
    }, this.KEEP_ALIVE_INTERVAL);
  }

  private startAckCheck(): void {
    this.ackCheckTimer = setInterval(() => {
      if (this.outgoingUnackMsg.length > 0 && Date.now() - this.lastAckTime > this.ACK_TIMEOUT) {
        this._onSocketClose.fire();
      }
      // The oldest unacknowledged message exceeded the grace window (peer screen-locked or in the background too long) → abandon the session.
      const oldest = this.outgoingUnackMsg[0];
      if (oldest && Date.now() - oldest.queuedAt > this.replayBufferGraceMs) {
        this.abandonSession();
      }
    }, this.ACK_TIMEOUT);
  }

  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }
    if (this.ackCheckTimer) {
      clearInterval(this.ackCheckTimer);
    }
    this.disposables.dispose();
    this._onMessage.dispose();
    this._onClose.dispose();
    this._onSocketClose.dispose();
    this._onSaturated.dispose();
    this._onDrained.dispose();
    this.socket.dispose();
  }
}
