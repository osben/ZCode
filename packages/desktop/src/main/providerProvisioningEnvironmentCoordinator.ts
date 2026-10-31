import type {
  ProviderProvisioningErrorCode,
  ProviderProvisioningLaneStatus,
  ProviderProvisioningSourceTrigger,
  ProviderProvisioningTrigger,
} from "@zcode/shared";

type ExecuteSync = (trigger: ProviderProvisioningTrigger) => Promise<void>;

type LaneResult = NonNullable<
  Extract<ProviderProvisioningLaneStatus, { lane: "present" }>["lastResult"]
>;

interface Registration {
  readonly id: string;
  readonly execute: ExecuteSync;
  /** Source device owning this registration; the data-sync page finds its lane by it.
   *  Legacy-format connections have no sourceServerId. */
  readonly sourceServerId?: string;
}

interface EnvironmentLane {
  readonly registrations: Map<string, Registration>;
  generation: number;
  completedGeneration: number;
  trigger: ProviderProvisioningTrigger;
  drain: Promise<void> | null;
  /** Outcome of the most recent execution that truly finished (not taken over by another
   *   registration); in-memory only, never persisted. */
  lastResult?: LaneResult;
}

/** Failure on the execution side carrying a fixed stage code; the coordinator records only the
 *  stage code, not the remote free-form text. */
export class ProviderProvisioningExecutionError extends Error {
  constructor(
    message: string,
    readonly errorCode: ProviderProvisioningErrorCode,
  ) {
    super(message);
    this.name = "ProviderProvisioningExecutionError";
  }
}

/**
 * The Main process coordinates only Environment identity and execution generations; the selected Host always reads and passes configuration and credentials on demand.
 *
 * The data-sync page's latest result and retry (docs/remote/data-sync.md, "Model providers (read-only)")
 * treat the lane as their single source of truth:
 *
 * ```text
 * register / requestAll / retry ──▶ lane.generation += 1 ──▶ #startDrain (single-flight)
 *                                                            └─ #drain loops until completedGeneration == generation
 *                                                                 each execution ends ──▶ lane.lastResult = {at, outcome, errorCode?}
 * getLaneStatus(sourceServerId) ──▶ lanes with this device registered ──▶ { running: any drain != null, latest lastResult }
 * ```
 *
 * A retry merely advances the same lane's generation once more: a retry during an execution merges
 * into the current drain's trailing sync, adds no second sync chain, and has no auto-retry or
 * timeout release. When the first-connect failure merged this way ends the drain early, the retry
 * itself starts another round to execute its generation (see retry).
 */
export class ProviderProvisioningEnvironmentCoordinator {
  readonly #lanes = new Map<string, EnvironmentLane>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  register(
    environmentKey: string,
    registrationId: string,
    execute: ExecuteSync,
    sourceServerId?: string,
  ): {
    initialSync: Promise<void>;
    dispose(): void;
  } {
    const lane = this.#lanes.get(environmentKey) ?? createLane();
    const wasOffline = lane.registrations.size === 0;
    lane.registrations.set(registrationId, {
      id: registrationId,
      execute,
      ...(sourceServerId ? { sourceServerId } : {}),
    });
    this.#lanes.set(environmentKey, lane);
    if (wasOffline) {
      lane.generation += 1;
      lane.trigger = "environment-online";
    }
    const initialSync = this.#startDrain(lane);
    return {
      initialSync,
      dispose: () => {
        lane.registrations.delete(registrationId);
      },
    };
  }

  requestAll(trigger: ProviderProvisioningSourceTrigger): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const lane of this.#lanes.values()) {
      lane.generation += 1;
      lane.trigger = trigger;
      if (lane.registrations.size > 0) drains.push(this.#startDrain(lane));
    }
    return Promise.all(drains).then(() => undefined);
  }

  /**
   * Query lane status by device. With `waitForIdle`, wait for the current drain (including the
   * trailing sync) to finish before returning, so a page opened mid-execution gets that
   * execution's result without polling or timeouts.
   */
  async getLaneStatus(
    sourceServerId: string,
    options: { waitForIdle?: boolean } = {},
  ): Promise<ProviderProvisioningLaneStatus> {
    if (options.waitForIdle) {
      await Promise.all(
        this.#findLanes(sourceServerId).map((lane) => lane.drain?.catch(() => undefined)),
      );
    }
    return this.#readStatus(sourceServerId);
  }

  /**
   * User retry: only advance the generation of lanes the device has (trigger is `user-retry`),
   * and return the latest status after the advanced generation finishes executing. With no lane,
   * no sync runs at all.
   */
  async retry(sourceServerId: string): Promise<ProviderProvisioningLaneStatus> {
    const lanes = this.#findLanes(sourceServerId);
    if (lanes.length === 0) return { lane: "none" };
    await Promise.all(
      lanes.map(async (lane) => {
        lane.generation += 1;
        lane.trigger = "user-retry";
        const target = lane.generation;
        // Fix: when a retry merges into a first-connect drain that is still executing, a
        // first-connect failure throws out of the drain and ends it (the publish barrier cannot
        // wait for trailing generations), leaving the retry's generation unexecuted while
        // returning the first-connect failure. Fix: start another round after the drain ends if
        // this generation is still incomplete; every round either advances completedGeneration
        // or ends because registrations emptied, so it cannot spin.
        while (lane.completedGeneration < target && lane.registrations.size > 0) {
          // The first-connect failure is already recorded on the lane; here we only wait for the
          // execution to end.
          await this.#startDrain(lane).catch(() => undefined);
        }
      }),
    );
    return this.#readStatus(sourceServerId);
  }

  /**
   * The same Source connected over different links forms different lanes (the Environment key is
   * derived from transport, see R3 §8.3.2), so one device can map to several lanes; only lanes
   * that still hold a registration for the device count.
   */
  #findLanes(sourceServerId: string): EnvironmentLane[] {
    return [...this.#lanes.values()].filter((lane) =>
      [...lane.registrations.values()].some(
        (registration) => registration.sourceServerId === sourceServerId,
      ),
    );
  }

  /** With multiple lanes: running if any is executing; the latest result is the most recent one. */
  #readStatus(sourceServerId: string): ProviderProvisioningLaneStatus {
    const lanes = this.#findLanes(sourceServerId);
    if (lanes.length === 0) return { lane: "none" };
    let lastResult: LaneResult | undefined;
    for (const lane of lanes) {
      if (lane.lastResult && (!lastResult || lane.lastResult.at >= lastResult.at)) {
        lastResult = lane.lastResult;
      }
    }
    return {
      lane: "present",
      running: lanes.some((lane) => lane.drain !== null),
      ...(lastResult ? { lastResult: { ...lastResult } } : {}),
    };
  }

  #startDrain(lane: EnvironmentLane): Promise<void> {
    if (lane.drain) return lane.drain;
    const operation = this.#drain(lane).finally(() => {
      if (lane.drain === operation) lane.drain = null;
    });
    lane.drain = operation;
    return operation;
  }

  async #drain(lane: EnvironmentLane): Promise<void> {
    while (lane.completedGeneration < lane.generation && lane.registrations.size > 0) {
      const targetGeneration = lane.generation;
      const trigger = lane.trigger;
      const registration = lane.registrations.values().next().value as Registration | undefined;
      if (!registration) return;
      try {
        await registration.execute(trigger);
        lane.completedGeneration = targetGeneration;
        lane.lastResult = { at: this.#now(), outcome: "success" };
      } catch (error) {
        // When an execution Host exits, its registration is removed first; if another Host for the same Environment remains,
        // it takes over the current generation immediately. Ordinary remote failures are not auto-retried; they wait for the next official trigger or a user retry.
        if (!lane.registrations.has(registration.id) && lane.registrations.size > 0) continue;
        lane.completedGeneration = targetGeneration;
        lane.lastResult = {
          at: this.#now(),
          outcome: "failed",
          errorCode:
            error instanceof ProviderProvisioningExecutionError
              ? error.errorCode
              : "host-execution-failed",
        };
        // Initial synchronization is a Remote Workspace publish barrier and must not swallow failure as readiness;
        // sync failures after connecting are only recorded on the lane and never thrown here.
        if (trigger === "environment-online") throw error;
      }
    }
  }
}

function createLane(): EnvironmentLane {
  return {
    registrations: new Map(),
    generation: 0,
    completedGeneration: 0,
    trigger: "environment-online",
    drain: null,
  };
}
