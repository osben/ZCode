/**
 * Shared contract for all-process CPU / memory monitoring telemetry.
 *
 * This file contains only constants and pure validation shared by main and unit tests: process-role enums,
 * three event names, each event's property-key allowlist, property counts, and privacy checks.
 * Actual sampling and aggregation happen in desktop main.
 */

/** Ten process roles in the first phase. */
export const PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
  "cli_chat",
  "cli_aux",
  "mcp",
] as const;

export type ProcessResourceRole = (typeof PROCESS_RESOURCE_ROLES)[number];

/**
 * The self-sampling interval for zcode-cli is a cadence contract between the CLI and app:
 * on the CLI it is the timer interval; in main it defines both the duration of a CLI sample and
 * the base for the expiration threshold (two intervals). Both sides must use the same source or
 * changing the CLI cadence will silently make main's `sample_count` diverge from the expected value.
 */
export const ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

/**
 * Process lanes for zcode-cli.
 *
 * lane is not a CLI protocol field: the CLI process does not know which process manager launched it.
 * The app-side services layer tags samples according to their process manager when parsing them
 * (`chat` is a workspace-level Agent; the other two lanes belong to the control plane).
 */
export const PROCESS_RESOURCE_CLI_LANES = ["chat", "plugin", "mcp-status"] as const;

export type ProcessResourceCliLane = (typeof PROCESS_RESOURCE_CLI_LANES)[number];

/**
 * Lane-to-role mapping: `chat` maps to `cli_chat` (one process per workspace); the other two lanes combine into `cli_aux`.
 *
 * Default (no lane) maps to `cli_chat`. The only likely source is an older remote server that does not tag samples;
 * the chat lane is the long-lived process that uses resources in a remote workspace, so mapping to cli_chat is more accurate than dropping the sample.
 */
export function resolveCliProcessResourceRole(
  lane: ProcessResourceCliLane | undefined,
): Extract<ProcessResourceRole, "cli_chat" | "cli_aux"> {
  return lane === undefined || lane === "chat" ? "cli_chat" : "cli_aux";
}

/** Where the process actually runs; samples from remote CLI / MCP processes are tagged remote. */
export type ProcessResourceRuntimeSurface = "local" | "remote";

export const PROCESS_RESOURCE_EVENT_NAMES = {
  processWindow: "perf_process_window",
  systemWindow: "perf_system_window",
  toolExecResource: "perf_tool_exec_resource",
} as const;

export type ProcessResourceEventName =
  (typeof PROCESS_RESOURCE_EVENT_NAMES)[keyof typeof PROCESS_RESOURCE_EVENT_NAMES];

/** Maximum properties for one ARMS custom event (counted after combining global and event properties). */
export const ARMS_CUSTOM_EVENT_PROPERTY_LIMIT = 20;

/** Global properties shared by all resource events. */
const PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS = [
  "platform",
  "app_version",
  "arms_env",
  "device_mid",
] as const;

/**
 * All possible properties of `perf_process_window` (21 total).
 * A single event has at most 20: Node roles and renderer_main have 20 (including two heap fields, without mcp_id),
 * mcp has 19 (including mcp_id, without heap), and gpu / renderer_guest / chromium_other have 18.
 */
export const PERF_PROCESS_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "process_role",
  "runtime_surface",
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "mcp_id",
  "background_ratio",
  "uptime_minutes",
  "cpu_percent_p95",
  "cpu_percent_peak",
  "rss_kb_total_mean",
  "rss_kb_total_peak",
  "rss_kb_max_process_peak",
  "heap_used_kb_mean",
  "heap_used_kb_peak",
  "process_count_peak",
  "sample_count",
] as const;

/** All properties of `perf_system_window` (17 total). */
export const PERF_SYSTEM_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "background_ratio",
  "app_uptime_minutes",
  "system_cpu_percent_p95",
  "system_free_memory_kb_min",
  "app_cpu_percent_p95",
  "app_rss_kb_total_mean",
  "app_rss_kb_total_peak",
  "process_count_total_peak",
  "sample_count",
  "telemetry_self_ms",
] as const;

/** All properties of `perf_tool_exec_resource` (12 total; Windows omits two tree_* fields, for 10). */
export const PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "runtime_surface",
  "tool_name",
  "exit_kind",
  "tree_rss_kb_peak",
  "tree_cpu_time_ms",
  "sample_count",
  "cli_rss_kb",
  "system_free_memory_kb",
] as const;

const PROPERTY_KEY_WHITELIST: Record<ProcessResourceEventName, readonly string[]> = {
  [PROCESS_RESOURCE_EVENT_NAMES.processWindow]: PERF_PROCESS_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.systemWindow]: PERF_SYSTEM_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.toolExecResource]: PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS,
};

/**
 * Privacy boundary: property keys must not contain pid / path / workspace / session / task / command semantics.
 * `device_mid` and `mcp_id` do not match this pattern (`mid` and `p_id` are not substrings of `pid`).
 */
export const PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN =
  /pid|path|workspace|session|task|command/i;

export interface ProcessResourceEventPropertyCheck {
  /** Within the allowlist and count limit, with no privacy-sensitive keys. */
  ok: boolean;
  /** Number of properties actually reported (undefined values are not counted). */
  count: number;
  overLimit: boolean;
  unknownKeys: string[];
  forbiddenKeys: string[];
}

/** Validate a resource event's properties against the allowlist, count limit, and privacy boundary. */
export function checkProcessResourceEventProperties(
  eventName: ProcessResourceEventName,
  properties: Record<string, string | number | boolean | undefined>,
): ProcessResourceEventPropertyCheck {
  const whitelist = new Set(PROPERTY_KEY_WHITELIST[eventName]);
  const presentKeys = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  const unknownKeys = presentKeys.filter((key) => !whitelist.has(key));
  const forbiddenKeys = presentKeys.filter((key) =>
    PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN.test(key),
  );
  const count = presentKeys.length;
  const overLimit = count > ARMS_CUSTOM_EVENT_PROPERTY_LIMIT;

  return {
    ok: unknownKeys.length === 0 && forbiddenKeys.length === 0 && !overLimit,
    count,
    overLimit,
    unknownKeys,
    forbiddenKeys,
  };
}
