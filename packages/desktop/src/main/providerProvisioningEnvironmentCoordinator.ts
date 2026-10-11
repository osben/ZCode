import type { ProviderProvisioningTrigger } from "@zcode/shared";

type ExecuteSync = (trigger: ProviderProvisioningTrigger) => Promise<void>;

interface Registration {
  readonly id: string;
  readonly execute: ExecuteSync;
}

interface EnvironmentLane {
  readonly registrations: Map<string, Registration>;
  generation: number;
  completedGeneration: number;
  trigger: ProviderProvisioningTrigger;
  drain: Promise<void> | null;
}

/**
 * The Main process coordinates only Environment identity and execution generations; the selected Host always reads and passes configuration and credentials on demand.
 */
export class ProviderProvisioningEnvironmentCoordinator {
  readonly #lanes = new Map<string, EnvironmentLane>();

  register(
    environmentKey: string,
    registrationId: string,
    execute: ExecuteSync,
  ): {
    initialSync: Promise<void>;
    dispose(): void;
  } {
    const lane = this.#lanes.get(environmentKey) ?? createLane();
    const wasOffline = lane.registrations.size === 0;
    lane.registrations.set(registrationId, { id: registrationId, execute });
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

  requestAll(trigger: Exclude<ProviderProvisioningTrigger, "environment-online">): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const lane of this.#lanes.values()) {
      lane.generation += 1;
      lane.trigger = trigger;
      if (lane.registrations.size > 0) drains.push(this.#startDrain(lane));
    }
    return Promise.all(drains).then(() => undefined);
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
      } catch (error) {
        // When an execution Host exits, its registration is removed first; if another Host for the same Environment remains,
        // it immediately takes over the current generation. Ordinary remote failures are not retried automatically; wait for the next explicit trigger.
        if (!lane.registrations.has(registration.id) && lane.registrations.size > 0) continue;
        lane.completedGeneration = targetGeneration;
        // Initial synchronization is a Remote Workspace publish barrier and must not swallow failure as readiness;
        // synchronization after connection is downgraded to a warning by the executor and does not enter here.
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
