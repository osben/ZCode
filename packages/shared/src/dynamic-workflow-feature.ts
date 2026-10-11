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
 * Fold the “feature offered” state: both `onDemand` and `alwaysOn` mean enabled—the `/workflow` command, skills,
 * workflow tab on the Automations page, and Resume entry are available in both modes. The only difference is when model tools are registered
 * (launch.md “On demand: activation”); the CLI decides that from the mode, so this code does not participate.
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** Snapshot source, for observability: UI and logs use this to distinguish “disabled by server” from “local override.” It describes only where the offered value came from. */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

/**
 * Gray-release snapshot (launch.md “Gray release” and “The user’s choice”). It has two layers:
 *   - - Offered: a server key or local override determines whether the feature is available and its default mode; stored in `offeredMode`;
 *   - - Effective: when available, the user’s setting replaces the offered mode; stored in `mode` / `enabled`.
 * Legacy consumers read the effective value from `mode` / `enabled`; Settings reads `offeredMode` to decide whether to show the option and its “Default” label.
 */
export interface DynamicWorkflowClientConfig {
  /** Effective mode: the user’s choice when available and selected; otherwise the offeredMode. */
  readonly mode: DynamicWorkflowMode;
  /** Equal to isDynamicWorkflowModeEnabled(mode); stored separately so consumers do not each reimplement the collapsing rule. */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
  /** Mode offered by the server (or local override): any value other than disabled means the feature is available and is the Settings “Default” option. */
  readonly offeredMode: DynamicWorkflowMode;
  /** The effective user choice; when absent, follow the offered mode (no selection, invalid value, or feature not offered). */
  readonly userMode?: DynamicWorkflowMode;
}

export function createDynamicWorkflowClientConfig(
  offeredMode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return {
    mode: offeredMode,
    enabled: isDynamicWorkflowModeEnabled(offeredMode),
    source,
    offeredMode,
  };
}

/**
 * Whether the feature is offered (independent of user choice): show the Settings row only when offered.
 *
 * Fix rationale: a snapshot may come from an older Host without offeredMode (new UI—for example, a mobile remote-control bundle—connected to an older Desktop).
 * Previously, checking `!== "disabled"` treated a missing field as “offered,” showing the Settings row and writing a choice that the old Host did not recognize,
 * to its settings. Treat a missing or unrecognized offeredMode as not offered; only Hosts that understand user choices write this field.
 */
export function isDynamicWorkflowOffered(config: DynamicWorkflowClientConfig): boolean {
  const offeredMode = normalizeDynamicWorkflowMode(config.offeredMode);
  return offeredMode !== undefined && isDynamicWorkflowModeEnabled(offeredMode);
}

/**
 * The single implementation of the “server offers, user chooses” rule (launch.md “The user’s choice”):
 *   - - When the feature is not offered (offeredMode is disabled), the user’s choice has no effect; a choice can never enable a feature disabled by the server;
 *   - - When available, a valid user choice replaces the offered mode; an absent or invalid value (old files or values written by a future version) means follow the offer.
 * Derive only from `offeredMode`, so applying a choice to an already-resolved snapshot replaces rather than stacks: the Host latches the offer,
 * and reapplies the latest choice on every use.
 */
export function applyDynamicWorkflowUserMode(
  config: DynamicWorkflowClientConfig,
  userMode: unknown,
): DynamicWorkflowClientConfig {
  const offer = createDynamicWorkflowClientConfig(config.offeredMode, config.source);
  const choice = normalizeDynamicWorkflowMode(userMode);
  if (!choice || !isDynamicWorkflowOffered(offer)) return offer;
  return {
    ...offer,
    mode: choice,
    enabled: isDynamicWorkflowModeEnabled(choice),
    userMode: choice,
  };
}

/**
 * Pure function: fold remote envelope `configs.dynamicWorkflow` and local override environment variables into the offer, then apply the user choice.
 * Offer precedence: override > valid remote value > default. A successful remote response that **omits** this key also means disabled—
 * the server removing the key means disabled, so do not reuse an old snapshot (same decision as desktopContextPromptRollout).
 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
  userMode?: unknown;
}): DynamicWorkflowClientConfig {
  return applyDynamicWorkflowUserMode(resolveDynamicWorkflowOffer(input), input.userMode);
}

function resolveDynamicWorkflowOffer(input: {
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
