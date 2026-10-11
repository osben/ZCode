/**
 * Host and scheduler self-sampled heap source (third registry entry).
 *
 * Each utilityProcess reads `process.memoryUsage()` and `process.cpuUsage()` every 60 seconds and
 * sends the sample to main through parentPort. The message dispatcher calls `ingestXxx` here to
 * store the latest reading; the next 10-second tick adds it to the complete sample for that role as
 * `heap_used_kb_mean` / `heap_used_kb_peak`.
 *
 * Collect heap only: main's `getAppMetrics()` (role definition table) is the only source for CPU and
 * RSS. Mixing self-sampled 60-second readings into a 10-second series would distort `sample_count`
 * and statistics. Each reading contributes one heap sample and is cleared on delivery; never reuse
 * an old value as a current fact.
 */

import { nodeSelfResourceSampleSchema, type ProcessResourceRole } from "@zcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

/** Role → heap reading (KB) not yet delivered. */
const pendingHeapUsedKb = new Map<ProcessResourceRole, number>();

/**
 * The ingestion point accepts `unknown`: Host uses a response schema, while scheduler uses a private
 * protocol that has no shared validation in main. The two transport paths meet at one trust boundary
 * here, so validation lives only in this place.
 * Drop invalid messages (missing fields, wrong types, or extra fields) without throwing.
 */
function ingest(role: ProcessResourceRole, raw: unknown): void {
  const parsed = nodeSelfResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  // Hosts from multiple windows may arrive in the same tick; a later smaller heap must not replace an earlier peak.
  pendingHeapUsedKb.set(role, Math.max(pendingHeapUsedKb.get(role) ?? 0, parsed.data.heapUsedKb));
}

export function ingestHostSelfResourceSample(raw: unknown): void {
  ingest("host", raw);
}

export function ingestSchedulerSelfResourceSample(raw: unknown): void {
  ingest("scheduler", raw);
}

export const selfHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "self_heap",
  sample(context) {
    // Remove the reading before delivery so a delivery error cannot leave an old value for the next tick.
    const delivering = [...pendingHeapUsedKb];
    pendingHeapUsedKb.clear();
    for (const [role, heapUsedKb] of delivering) {
      context.addRoleHeapSample(role, heapUsedKb);
    }
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
