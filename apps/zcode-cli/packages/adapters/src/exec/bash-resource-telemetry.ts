import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import {
  BASH_RESOURCE_MAX_SAMPLES,
  BASH_RESOURCE_SAMPLE_INTERVAL_MS,
  type ZCodeToolExecResource,
} from "@zcode/shared";
import { createProcessProbe, type ProcessProbe } from "../device/process-probe.js";

import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { DEFAULT_PROGRESS_INTERVAL_MS } from "./execution-utils.js";

const BYTES_PER_KB = 1024;

interface BashResourceTelemetryOptions {
  processGroupId?: number;
  platform?: NodeJS.Platform;
  probe?: Pick<ProcessProbe, "sampleProcessGroup">;
  onComplete: (sample: ZCodeToolExecResource) => void;
  readContext?: () => Pick<ZCodeToolExecResource, "cliRssKb" | "systemFreeMemoryKb">;
}

/** Each command owns its state and probe-failure budget; finish closes it synchronously without waiting for telemetry I/O. */
export function createBashResourceTelemetry(options: BashResourceTelemetryOptions): {
  finish(exitKind: ZCodeToolExecResource["exitKind"]): void;
} {
  const platform = options.platform ?? process.platform;
  const startedAt = performance.now();
  const probe = options.probe ?? createProcessProbe({ platform });
  const cpuByPid = new Map<number, number>();
  let finished = false;
  let lastSampleElapsedMs = 0;
  let attempts = 0;
  let sampleCount = 0;
  let treeRssKbPeak = 0;
  let treeCpuTimeMs = 0;
  let unsubscribe: (() => void) | undefined;

  const sample = async () => {
    const elapsedMs = performance.now() - startedAt;
    if (finished || elapsedMs - lastSampleElapsedMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
    lastSampleElapsedMs = elapsedMs;
    attempts += 1;
    try {
      const rows = await probe.sampleProcessGroup(options.processGroupId!);
      // The state is closed when the root exits; late /proc or ps results must not modify a summary already sent.
      if (finished || !rows?.length) return;
      sampleCount += 1;
      let rssKb = 0;
      for (const row of rows) {
        rssKb += row.rssKb;
        if (row.cpuTimeMs === undefined) continue;
        const previous = cpuByPid.get(row.pid) ?? 0;
        treeCpuTimeMs += Math.max(0, row.cpuTimeMs - previous);
        cpuByPid.set(row.pid, row.cpuTimeMs);
      }
      treeRssKbPeak = Math.max(treeRssKbPeak, rssKb);
    } catch {
      // Telemetry failures drop only the current sample and must not change Bash exit, output, or timeout behavior.
    } finally {
      if (attempts === BASH_RESOURCE_MAX_SAMPLES) unsubscribe?.();
    }
  };
  if (platform !== "win32" && options.processGroupId !== undefined) {
    // Reuse Bash's existing shared one-second poller. Gate by command start time so phase skew can
    // delay sampling by at most one poll, but never sample early.
    unsubscribe = subscribeBashOutputProgress(DEFAULT_PROGRESS_INTERVAL_MS, sample);
  }

  return {
    finish(exitKind) {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      cpuByPid.clear();
      const durationMs = performance.now() - startedAt;
      if (durationMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
      try {
        const context = options.readContext?.() ?? {
          cliRssKb: process.memoryUsage.rss() / BYTES_PER_KB,
          systemFreeMemoryKb: freemem() / BYTES_PER_KB,
        };
        options.onComplete({
          // Multiple connections and windows may forward the same fact; emit it once after the
          // command is closed so main can deduplicate by identity.
          completionToken: randomUUID(),
          platform,
          toolName: "bash",
          durationMs,
          exitKind,
          sampleCount,
          ...context,
          ...(platform === "win32" ? {} : { treeRssKbPeak, treeCpuTimeMs }),
        });
      } catch {
        // If IPC is closed or context reading fails, drop only the notification; do not affect the command result.
      }
    },
  };
}
