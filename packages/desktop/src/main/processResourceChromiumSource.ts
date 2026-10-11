/**
 * Resource sample source for Chromium processes (main / renderer / gpu / utility).
 *
 * Read `app.getAppMetrics()` every 10 seconds, aggregate by role, and pass the result to the window aggregator.
 * The main process does not use external processes; this uses in-process APIs only.
 */

import { app, type ProcessMetric } from "electron";
import os from "node:os";
import { normalizeElectronCpuToMachinePercent } from "./electronCpuNormalization.js";
import {
  aggregateChromiumProcessRoles,
  sumChromiumRoleAggregates,
  type ChromiumProcessMetricSample,
} from "./processResourceRoleClassifier.js";
import { collectChromiumProcessRolePids } from "./resourceManagerWindow.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

function toNormalizedSample(
  metric: ProcessMetric,
  logicalCpuCount: number,
): ChromiumProcessMetricSample {
  return {
    pid: metric.pid,
    type: metric.type,
    cpuPercent: normalizeElectronCpuToMachinePercent(metric.cpu.percentCPUUsage, {
      logicalCpuCount,
    }),
    // getAppMetrics reports memory.workingSetSize in KB.
    rssKb: metric.memory.workingSetSize ?? 0,
    creationTime: metric.creationTime,
  };
}

export const chromiumProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "chromium",
  sample(context) {
    const metrics = app.getAppMetrics();
    const logicalCpuCount = os.cpus().length;
    const aggregates = aggregateChromiumProcessRoles({
      processes: metrics.map((metric) => toNormalizedSample(metric, logicalCpuCount)),
      pids: collectChromiumProcessRolePids(),
      now: context.now,
    });

    // ChromiumRoleAggregate is the Chromium subset of ProcessRoleSample (without heap / mcpId / hardware).
    // Copying fields individually could silently break if the field names drift apart.
    for (const aggregate of aggregates) {
      context.addRoleSample(aggregate);
    }
    // Device-level events need the exact application total for this tick. If sampling throws, this
    // line does not run, so the tick has no device sample; never present an old reading as current.
    context.addAppProcessTotals(sumChromiumRoleAggregates(aggregates));
  },
};
