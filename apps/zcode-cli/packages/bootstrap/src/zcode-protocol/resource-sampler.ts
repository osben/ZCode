import type { Logger } from "@zcode/contracts";
import {
  createMemorySampleWriteGate,
  memoryUsageToSampleFields,
  zcodeProtocolNotifications,
  type MemorySample,
  type ZCodeProtocolNotification,
} from "@zcode/shared";
import {
  createZCodeProcessResourceSampler,
  type ZCodeProcessResourceSampler,
} from "../process-resource-sampler.js";
import type { ZCodeProtocolAgentServer } from "./server.js";

export function startProtocolResourceSampler(
  server: ZCodeProtocolAgentServer,
  send: (message: ZCodeProtocolNotification) => void,
  logger: Logger,
): ZCodeProcessResourceSampler | undefined {
  try {
    // Local in-memory diagnostic log: reuse the same 60s interval and write a line only after
    // change/heartbeat gating, avoiding disk writes at the same rate as the message stream.
    const memoryDiagnosticsGate = createMemorySampleWriteGate();
    const sampler = createZCodeProcessResourceSampler({
      onSample: (sample, memoryUsage) => {
        send({
          method: zcodeProtocolNotifications.processResourceSample,
          params: sample,
        });
        // Use the resource sampling interval (60s) as a fallback for resident session TTL/watermark
        // reconciliation; do not add another timer. The sampler already catches onSample errors, so
        // one rebalance failure does not affect telemetry reporting.
        server.rebalanceResidentSessions();
        try {
          // On the same interval, first evict transient events by time as a fallback, then sample;
          // eventRows in the log will reflect the post-eviction resident count.
          server.pruneSessionEventStores();
          server.pruneDetachedChildPublishers();
        } catch {
          // A fallback eviction failure does not affect resource reporting or diagnostic logs.
        }
        try {
          const memorySample: MemorySample = {
            role: "agent_node",
            ...memoryUsageToSampleFields(memoryUsage),
            counters: server.collectMemoryDiagnostics(),
          };
          const reason = memoryDiagnosticsGate.evaluate(memorySample, Date.now());
          if (reason) {
            const { role: _role, counters, ...memoryFields } = memorySample;
            logger.info("Process memory sample", {
              event: "zcode_protocol.process.memory_sample",
              reason,
              ...memoryFields,
              counters,
            });
          }
        } catch {
          // A diagnostic log failure drops only the current sample and does not affect resource reporting or rebalance.
        }
      },
    });
    sampler.start();
    return sampler;
  } catch {
    // Resource telemetry is best effort; initialization failure must not change the Agent startup result.
    return undefined;
  }
}
