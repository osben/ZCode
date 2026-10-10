// ============================================================
// Dynamic Workflow rollout: server feature-key values and the client snapshot.
// ============================================================
// The server sends `data.configs.dynamicWorkflow.mode` via `/api/v1/client/configs`.

// This contains only the value set, normalization, and snapshot shape shared by Host services, Desktop main, and UI;
// Each owner handles remote reads, overrides, and delivery; the shared layer makes no requests.

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * Environment variable for local overrides. Semantics have three build-profile layers; Desktop main **rewrites or deletes** it before forking the Host
 * (`buildHostProcessEnv` in desktopRuntimeEnv.ts), and the Host consumes the value without distinguishing its source:
 *   - Unpackaged dev: pass through a valid value from the developer's shell;
 *   - Packaged preview: always set `alwaysOn`, ignoring the shell;
 *   - Packaged production: delete inherited values and never set it.
 * Web/server Hosts without main read the process environment directly (set by operators/developers).
 */
export const ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/** Value used when the server omits it, the format is invalid, or the request fails: fail-closed, matching the off-peak task rollout. */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * Parses the three states preserved by the server contract; consumers convert them to a boolean switch consistently.
 * If onDemand gains distinct behavior in the future, only consumers need to change.
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** Snapshot source for observability; UI and logs use it to distinguish "disabled by server" from "local override." */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

export interface DynamicWorkflowClientConfig {
  readonly mode: DynamicWorkflowMode;
  /** Equal to isDynamicWorkflowModeEnabled(mode); stored separately so consumers do not each reimplement the collapsing rule. */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
}

export function createDynamicWorkflowClientConfig(
  mode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return { mode, enabled: isDynamicWorkflowModeEnabled(mode), source };
}

/**
 * Pure function: folds remote `configs.dynamicWorkflow` from the envelope and the local override environment variable into one snapshot.
 * Priority: override > valid remote value > default. If the remote request succeeds but **omits** this key, treat it as disabled —
 * removing the key on the server means turning the feature off; do not reuse an old snapshot (same decision as desktopContextPromptRollout).
 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig {
  const override = normalizeDynamicWorkflowMode(input.env?.[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
  if (override) return createDynamicWorkflowClientConfig(override, "override");
  const remoteMode = normalizeDynamicWorkflowMode(
    typeof input.remote === "object" && input.remote !== null
      ? (input.remote as { mode?: unknown }).mode
      : undefined,
  );
  if (remoteMode) return createDynamicWorkflowClientConfig(remoteMode, "remote");
  return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
}
