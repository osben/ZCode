import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import {
  createPipSessionClient,
  type PipSessionClient,
  type PipSessionClientOptions,
} from "@zcode/zcode-cua/pip-session/node";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { CuaPipSessionService } from "./cuaPipSession.js";

export interface CuaPipPresentationCredentials {
  socketPath: string;
}

type PipSessionClientResolution =
  | { client: PipSessionClient; skipReason?: never }
  | {
      client: null;
      skipReason:
        | "service-disabled"
        | "service-disposed"
        | "credentials-unavailable"
        | "transport-disabled";
    };

function eventLogContext(event: PipSessionEvent): Record<string, unknown> {
  if (event.kind === "focus-changed") {
    return {
      kind: event.kind,
      revision: event.revision,
      sessionId: event.sessionId,
      sourceWindowId: event.sourceWindowId,
    };
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    sequenceNumber: event.sequenceNumber,
    sessionId: event.sessionId,
    ...(event.kind === "session-closed" ? {} : { turnId: event.turnId }),
    ...(event.kind === "turn-ended" ? { outcome: event.outcome } : {}),
  };
}

export function createCuaPipSessionService(options: {
  enabled: boolean;
  resolveCredentials: () => Promise<CuaPipPresentationCredentials | undefined>;
  createClient?: (options: PipSessionClientOptions) => PipSessionClient;
  logger?: ServiceLogger;
}): CuaPipSessionService {
  const logger = options.logger ?? createServiceLogger("cua-pip-session");
  const clientFactory = options.createClient ?? createPipSessionClient;
  let current: {
    key: string;
    client: PipSessionClient;
  } | null = null;
  let disabledTransportKey: string | null = null;
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;
  /**
   * The `turn-started` event dropped with `credentials-unavailable`, to be replayed when credentials become available.
   *
   * PiP is scoped to a turn; without
   * `turn-started`, no PiP window opens. This event **must** come before the Helper—the Helper starts lazily on the first CUA tool
   * call, while `turn-started` is sent at the beginning of the turn. At that point, `resolveCredentials()` has neither
   * a managed host nor a stable socket to probe (that path is probe-only and does not start it), so it returns undefined.
   * Logs confirmed: turn-started(seq 3) → credentials-unavailable; then the Helper starts,
   * focus-changed(rev 11/12/13) all have applied:true; turn-ended(seq 3862) →
   * applied:false / turn-mismatch. The channel works; only the opening event was dropped.
   *
   * An earlier comment in this file already said "turn-started used to be silently dropped, leaving PiP permanently on the previous completed turn",
   * but the earlier fix added only a warn log and did not replay it. A single-prompt task has no second turn, so in practice
   * PiP never appeared.
   *
   * Cache only one event: a new turn-started replaces the old one (the old turn has ended, and replaying it would open a turn
   * that should already be closed). The coordinator deduplicates by `sequenceNumber`, so replay is idempotent.
   */
  let pendingTurnStarted: { event: PipSessionEvent; turnId: string } | null = null;
  /**
   * Replay retry timer.
   *
   * Why waiting for "the next event that happens to arrive" is not enough to trigger a replay:
   *   20:18:15.628  turn-started → credentials-unavailable (Helper not running)
   *   20:18:23      Helper starts → first capture_app → bindCapture → pending-turn
   *                 (coordinator's PIP_SESSION_CAPTURE_PENDING_TTL_MS = 2s, expires around 20:18:25)
   *   20:18:30.420  next event arrives; replay succeeds with applied:true—but 5 seconds too late
   * The capture staged when the turn began has expired, captureAccepted no longer fires, and the window still does not open.
   *
   * Therefore, replay as soon as credentials become available: start bounded polling when staging the event and stop when it succeeds. Use a 250 ms interval,
   * far below the coordinator's 2 s TTL; the 30 s limit covers Helper cold start (including the initial TCC authorization dialog).
   */
  let replayTimer: ReturnType<typeof setTimeout> | null = null;
  const REPLAY_RETRY_MS = 250;
  const REPLAY_DEADLINE_MS = 30_000;
  let replayDeadline = 0;
  /**
   * Skip-streak aggregation for delivery-skip logging. Focus events fire on every window-focus change, so a Helper
   * without credentials spammed one warn per event (554 warns/day, log triage 2026-10-15). While skips continue for
   * the same reason, only the first skip logs at warn, repeats go to debug with a running total, and delivery
   * recovery emits a single warn carrying the aggregate. Replay behavior is not affected.
   */
  let skipStreak: {
    reason: "credentials-unavailable" | "transport-disabled";
    dropped: number;
  } | null = null;
  let deliveryFailureStreak = 0;

  // Any successful send ends the streak, including the retry-timer replay of a deferred
  // turn-started: transport recovered there too, so a later skip must start a new warn
  // streak instead of continuing the previous debug-only streak.
  const reportDeliveryRecovered = (): void => {
    if (skipStreak !== null) {
      logger.warn(undefined, "[cua-pip-session] event delivery recovered", {
        skipReason: skipStreak.reason,
        skippedEvents: skipStreak.dropped,
      });
      skipStreak = null;
    }
    if (deliveryFailureStreak > 0) {
      logger.info(undefined, "[cua-pip-session] event delivery recovered after send failures", {
        failureStreak: deliveryFailureStreak,
      });
      deliveryFailureStreak = 0;
    }
  };

  const reportDeliveryFailed = (event: PipSessionEvent, error: unknown, message: string): void => {
    deliveryFailureStreak += 1;
    const log = deliveryFailureStreak === 1 ? logger.warn : logger.debug;
    log(undefined, message, {
      ...eventLogContext(event),
      failureStreak: deliveryFailureStreak,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  };

  const cancelReplayRetry = () => {
    if (replayTimer !== null) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  };

  const getClient = async (): Promise<PipSessionClientResolution> => {
    if (!options.enabled) return { client: null, skipReason: "service-disabled" };
    if (disposed) return { client: null, skipReason: "service-disposed" };
    const credentials = await options.resolveCredentials();
    if (!credentials) return { client: null, skipReason: "credentials-unavailable" };
    const key = credentials.socketPath;
    if (disabledTransportKey === key) {
      return { client: null, skipReason: "transport-disabled" };
    }
    if (current?.key === key) return { client: current.client };
    current?.client.close();
    const client = clientFactory({
      socketPath: credentials.socketPath,
      onDiagnostic: (diagnostic) => {
        const message = `[cua-pip-session] ${diagnostic.code}: ${diagnostic.message}`;
        if (diagnostic.code === "version_mismatch") logger.warn(undefined, message);
        else logger.debug(undefined, message);
      },
    });
    current = { key, client };
    try {
      await client.connect();
      return { client };
    } catch (error) {
      if (current?.client === client) current = null;
      client.close();
      if ((error as { code?: unknown }).code === "version_mismatch") {
        disabledTransportKey = key;
      }
      throw error;
    }
  };

  /**
   * Bounded polling: send the staged turn-started as soon as credentials are available, without waiting for another event.
   * Serialize through the same `tail` to avoid a race with publish that could put the replay after the current event.
   */
  const scheduleReplayRetry = (): void => {
    cancelReplayRetry();
    if (disposed || pendingTurnStarted === null) return;
    if (Date.now() >= replayDeadline) {
      logger.warn(undefined, "[cua-pip-session] deferred turn-started expired before transport", {
        ...eventLogContext(pendingTurnStarted.event),
      });
      pendingTurnStarted = null;
      return;
    }
    replayTimer = setTimeout(() => {
      replayTimer = null;
      if (disposed || pendingTurnStarted === null) return;
      const operation = tail.then(async () => {
        if (disposed || pendingTurnStarted === null) return;
        let resolution;
        try {
          resolution = await getClient();
        } catch {
          // Connection failed (Helper has just started and is not listening yet): wait for the next poll.
          scheduleReplayRetry();
          return;
        }
        if (!resolution.client) {
          scheduleReplayRetry();
          return;
        }
        const replay = pendingTurnStarted;
        pendingTurnStarted = null;
        try {
          const result = await resolution.client.send(replay.event);
          logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
            ...eventLogContext(replay.event),
            applied: result.applied,
            reason: result.reason,
          });
          reportDeliveryRecovered();
        } catch (error) {
          // Keep the event staged so the next bounded poll can retry after a transient send failure.
          pendingTurnStarted = replay;
          scheduleReplayRetry();
          reportDeliveryFailed(
            replay.event,
            error,
            "[cua-pip-session] replay of deferred turn-started failed",
          );
        }
      });
      tail = operation;
    }, REPLAY_RETRY_MS);
    // The polling timer must not keep the process alive; it waits for a Helper that may never appear.
    replayTimer.unref?.();
  };

  const publish = (event: PipSessionEvent): Promise<void> => {
    if (disposed) return Promise.resolve();
    const operation = tail.then(async () => {
      try {
        const resolution = await getClient();
        if (!resolution.client) {
          if (
            resolution.skipReason === "credentials-unavailable" ||
            resolution.skipReason === "transport-disabled"
          ) {
            // Account for lost events (see the root-cause comment for pendingTurnStarted): if turn-started is dropped, replay it when credentials become available;
            // if turn-ended for the same turn is also dropped, invalidate the cache too—the turn completed while
            // transport was unavailable, and replaying it would open a turn that should already be closed.
            if (event.kind === "turn-started") {
              pendingTurnStarted = { event, turnId: event.turnId };
              replayDeadline = Date.now() + REPLAY_DEADLINE_MS;
              scheduleReplayRetry();
            } else if (
              (event.kind === "turn-ended" || event.kind === "session-closed") &&
              pendingTurnStarted !== null &&
              ("turnId" in event
                ? pendingTurnStarted.turnId === event.turnId
                : pendingTurnStarted.event.sessionId === event.sessionId)
            ) {
              pendingTurnStarted = null;
              cancelReplayRetry();
            }
            // Bug diagnosis: when the Helper was running but credential handoff failed, turn-started used to be silently dropped, leaving PiP
            // permanently on the previous completed turn. The first skip of a streak stays at warn so a real outage remains visible; repeats are
            // demoted to debug (see skipStreak) and a recovery warn reports the aggregated count.
            if (skipStreak !== null && skipStreak.reason === resolution.skipReason) {
              skipStreak.dropped += 1;
              logger.debug(undefined, "[cua-pip-session] event delivery skipped", {
                ...eventLogContext(event),
                skipReason: resolution.skipReason,
                droppedTotal: skipStreak.dropped,
              });
            } else {
              skipStreak = { reason: resolution.skipReason, dropped: 1 };
              logger.warn(undefined, "[cua-pip-session] event delivery skipped", {
                ...eventLogContext(event),
                skipReason: resolution.skipReason,
              });
            }
          } else {
            // service-disabled / service-disposed used to return silently,
            // making "no PiP event was sent" indistinguishable in logs from "sent but rejected"—troubleshooting had to infer four silent early returns in the delivery path.
            // Lifecycle events are constant per turn, so warnings do not create per-frame disk writes.
            logger.warn(undefined, "[cua-pip-session] event delivery dropped", {
              ...eventLogContext(event),
              skipReason: resolution.skipReason,
            });
          }
          return;
        }
        // Credentials are available: replay the opening event first so the coordinator has an open turn to receive subsequent events.
        // Do not replay when the current event is itself turn-started; it has already replaced the cached event.
        cancelReplayRetry();
        const replay = event.kind === "turn-started" ? null : pendingTurnStarted;
        pendingTurnStarted = null;
        if (replay !== null) {
          try {
            const replayed = await resolution.client.send(replay.event);
            logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
              ...eventLogContext(replay.event),
              applied: replayed.applied,
              reason: replayed.reason,
            });
          } catch (error) {
            // Keep retrying the opening event while still delivering the current event.
            pendingTurnStarted = replay;
            scheduleReplayRetry();
            reportDeliveryFailed(
              replay.event,
              error,
              "[cua-pip-session] replay of deferred turn-started failed",
            );
          }
        }
        const result = await resolution.client.send(event);
        reportDeliveryRecovered();
        // Bug diagnosis: PiP group switching crosses Main, Host, and broker processes; if successful and idempotently rejected ACKs are logged only at
        // debug, packaged builds cannot distinguish an unsent turn-started from stale-sequence/turn-mismatch.
        // These are low-frequency lifecycle logs and contain no screenshots, tokens, or prompts, so they are safe to keep in production.
        logger.info(undefined, "[cua-pip-session] event delivery acknowledged", {
          ...eventLogContext(event),
          applied: result.applied,
          reason: result.reason,
        });
      } catch (error) {
        reportDeliveryFailed(event, error, "[cua-pip-session] event delivery failed");
      }
    });
    tail = operation;
    return operation;
  };

  return {
    publishFocus: publish,
    publishLifecycle: publish,
    dispose() {
      disposed = true;
      cancelReplayRetry();
      pendingTurnStarted = null;
      current?.client.close();
      current = null;
    },
  };
}
