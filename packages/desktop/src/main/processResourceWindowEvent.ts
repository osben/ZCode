/** Property projection for `perf_process_window` (pure function; property keys match the allowlist one-to-one). */

import type { ArmsRumEnv } from "@zcode/shared";
import { PROCESS_RESOURCE_EVENT_NAMES } from "@zcode/shared";
import type {
  ProcessResourceHardware,
  ProcessRoleWindowReport,
} from "./processResourceWindowAggregator.js";

export const PERF_PROCESS_WINDOW_EVENT_NAME = PROCESS_RESOURCE_EVENT_NAMES.processWindow;

export interface ProcessResourceReportContext {
  deviceMid: string;
  appVersion: string;
  armsEnv: ArmsRumEnv;
  /** Desktop hardware; overridden when the sample carries its own hardware (remote CLI / MCP). */
  desktopHardware: ProcessResourceHardware;
}

/** The ARMS `platform` dimension has only these three values; dashboards group by it. */
export type ProcessResourceOsCategory = "macos" | "windows" | "linux";

export function normalizeOsCategory(platform: NodeJS.Platform): ProcessResourceOsCategory {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * Property order matches the event contract. Properties with undefined values are omitted from the
 * final payload, so gpu / renderer_guest / chromium_other naturally have 18 properties.
 */
export function buildProcessWindowEventProperties(
  report: ProcessRoleWindowReport,
  context: ProcessResourceReportContext,
): Record<string, string | number | undefined> {
  // Override field by field: when a remote CLI provides only platform / arch / core count,
  // total_memory_gb still comes from the desktop machine.
  const hardware = { ...context.desktopHardware, ...report.hardware };
  return {
    platform: normalizeOsCategory(hardware.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
    device_mid: context.deviceMid,
    process_role: report.role,
    runtime_surface: report.runtimeSurface,
    arch: hardware.arch,
    logical_cpu_count: hardware.logicalCpuCount,
    total_memory_gb: hardware.totalMemoryGb,
    mcp_id: report.mcpId,
    background_ratio: report.backgroundRatio,
    uptime_minutes: report.uptimeMinutes,
    cpu_percent_p95: report.cpuPercentP95,
    cpu_percent_peak: report.cpuPercentPeak,
    rss_kb_total_mean: report.rssKbTotalMean,
    rss_kb_total_peak: report.rssKbTotalPeak,
    rss_kb_max_process_peak: report.rssKbMaxProcessPeak,
    heap_used_kb_mean: report.heapUsedKbMean,
    heap_used_kb_peak: report.heapUsedKbPeak,
    process_count_peak: report.processCountPeak,
    sample_count: report.sampleCount,
  };
}
