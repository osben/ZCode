import {
  getWebRemoteControlHeartbeatDelayMs,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
} from "#src/web-remote-relay/domain/heartbeatTiming.js";

/** The ACK deadline is independent of the jittered heartbeat; both transports reuse it and do not replay heartbeats missed during sleep. */
export class WebRemoteControlV2Heartbeat {
  private heartbeat?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly query: () => void,
    private readonly expired: () => void,
    private readonly timing: {
      intervalMs?: number;
      jitterMs?: number;
      ackTimeoutMs?: number;
    } = {},
  ) {}
  acknowledged(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      this.expired,
      this.timing.ackTimeoutMs ?? WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
    );
    if (!this.heartbeat) this.schedule();
  }
  stop(): void {
    clearTimeout(this.heartbeat);
    clearTimeout(this.watchdog);
    this.heartbeat = this.watchdog = undefined;
  }
  private schedule(): void {
    this.heartbeat = setTimeout(
      () => {
        this.heartbeat = undefined;
        this.query();
        this.schedule();
      },
      getWebRemoteControlHeartbeatDelayMs(
        this.timing.intervalMs ?? WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
        this.timing.jitterMs ??
          (this.timing.intervalMs === undefined
            ? WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS
            : undefined),
      ),
    );
  }
}
