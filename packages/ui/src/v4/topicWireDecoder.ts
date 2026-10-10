import {
  TopicWireFrameAssembler,
  type TopicWireAssemblyEvent,
  type TopicWireAssemblyFault,
  type TopicFrameDeliveryKind,
  type TopicWireFrameCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

interface TopicWireDecoder {
  accept(wire: TopicWireFrameCandidate): void;
  /** Same-sub recovery: clear only the fail-closed flag and retain the assembler ordinal tombstone. */
  recover(topic: string, subscriptionId: string): void;
  discard(topic: string, subscriptionId: string): void;
  clear(): void;
}

/**
 * Renderer-side atomic boundary from physical to logical frames. The assembler emits a logical frame only when all chunks are present and validated;
 * one timer for the nearest deadline drives the 30s timeout, avoiding a timer per chunk.
 */
export function createTopicWireDecoder<F extends { topic: string; subscriptionId: string }>(
  assembler: TopicWireFrameAssembler<F>,
  deliver: (frame: F, deliveryKind: TopicFrameDeliveryKind) => void,
  onFault?: (fault: TopicWireAssemblyFault) => void,
): TopicWireDecoder {
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const faultedRoutes = new Set<string>();
  const routeKey = (topic: string, subscriptionId: string) => `${topic}\0${subscriptionId}`;

  const handleEvents = (events: TopicWireAssemblyEvent<F>[]): void => {
    const faults = events.filter((event) => event.kind === "fault");
    const failedInBatch = new Set<string>();
    const healingRoutes = new Set<string>();
    for (const event of events) {
      if (event.kind === "complete" && event.deliveryKind === "recovery") {
        healingRoutes.add(routeKey(event.frame.topic, event.frame.subscriptionId));
      }
    }
    for (const { fault } of faults) {
      const key = routeKey(fault.topic, fault.subscriptionId);
      // assembler.accept expires old assemblies before processing the current wire. If the current wire is a
      // fully validated recovery with a higher ordinal, it authoritatively supersedes the old online timeout in the same batch;
      // do not report the fault first and then discard the recovery.
      if (healingRoutes.has(key)) continue;
      failedInBatch.add(key);
      faultedRoutes.add(key);
      assembler.abort(fault.topic, fault.subscriptionId);
      logger.warn("[v4-topic-wire] physical assembly rejected", fault);
      onFault?.(fault);
    }
    for (const event of events) {
      if (event.kind !== "complete") continue;
      const key = routeKey(event.frame.topic, event.frame.subscriptionId);
      if (event.deliveryKind === "recovery") faultedRoutes.delete(key);
      // A single accept may produce [superseded fault(A), complete(A)], so the same route must
      // fail closed. However, accept(B) may also expire another route A, so do not discard healthy B by mistake.
      if (failedInBatch.has(key) || faultedRoutes.has(key)) continue;
      deliver(event.frame, event.deliveryKind);
    }
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    const nextExpiryAt = assembler.nextExpiryAt;
    if (nextExpiryAt === null) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        handleEvents(assembler.expire(Date.now()));
        scheduleExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
  };

  return {
    accept(wire) {
      const key = routeKey(wire.topic, wire.subscriptionId);
      if (faultedRoutes.has(key)) {
        // While resync is in flight, a late old online fragment can still fault and close the route;
        // the actual recovery would then be permanently swallowed by the old gate. deliveryKind is an authoritative publisher
        // envelope fact, so only an exact recovery can atomically open the gate; never infer it from RPC timing.
        if (wire.deliveryKind !== "recovery") return;
        faultedRoutes.delete(key);
        assembler.abort(wire.topic, wire.subscriptionId);
      }
      handleEvents(assembler.accept(wire));
      scheduleExpiry();
    },
    recover(topic, subscriptionId) {
      // Do not clear faultedRoutes only through unsubscribe/discard; a higher-ordinal same-subscription
      // recovery would otherwise be swallowed forever. Open only the fail-closed gate here and retain the assembler's
      // settled ordinal so late old fragments are still discarded silently.
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.abort(topic, subscriptionId);
      scheduleExpiry();
    },
    discard(topic, subscriptionId) {
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.discard(topic, subscriptionId);
      scheduleExpiry();
    },
    clear() {
      faultedRoutes.clear();
      assembler.clear();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
    },
  };
}
