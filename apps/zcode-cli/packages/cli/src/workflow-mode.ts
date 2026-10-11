// Dynamic workflow mode for the standalone CLI (see docs/dynamic-workflow/launch.md "The standalone CLI: `--workflow-mode`").
// The TUI and headless modes do not receive a rollout mode from the Host; the process arguments
// determine it. The default is disabled, so workflows must be explicitly enabled in the standalone CLI.
// Convert mode to the two explicit core fields here; bootstrap/core retain the same behavior as the protocol server.
import {
  DYNAMIC_WORKFLOW_MODES,
  normalizeDynamicWorkflowMode,
  type DynamicWorkflowMode,
} from "@zcode/shared";

export const DEFAULT_CLI_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

export const WORKFLOW_MODE_SCOPE_ERROR =
  "--workflow-mode can only be used with --prompt, --target, or tui.";

export const WORKFLOW_DISABLED_NOTICE =
  "Dynamic workflows are disabled in this session. Restart with --workflow-mode onDemand or --workflow-mode alwaysOn to use them.";

export type CliWorkflowRuntimeConfig = {
  dynamicWorkflowEnabled: boolean;
  dynamicWorkflowToolsOnDemand: boolean;
};

/** Throw on invalid values for the entry point to format; do not supply a default here, since the entry point uses absence to check scope. */
export function normalizeWorkflowModeOption(
  value: string | undefined,
): DynamicWorkflowMode | undefined {
  if (value === undefined) return undefined;
  const mode = normalizeDynamicWorkflowMode(value);
  if (mode !== undefined) return mode;
  throw new Error(
    `Unsupported --workflow-mode value: ${value}. Supported modes: ${DYNAMIC_WORKFLOW_MODES.join(", ")}.`,
  );
}

/**
 * Write both fields explicitly: core treats absence as enabled (subagents and in-process embedders
 * rely on this default), so leaving them empty in the standalone CLI would bypass its disabled default.
 */
export function resolveWorkflowModeRuntimeConfig(
  mode: DynamicWorkflowMode,
): CliWorkflowRuntimeConfig {
  return {
    dynamicWorkflowEnabled: mode !== "disabled",
    dynamicWorkflowToolsOnDemand: mode === "onDemand",
  };
}

export function isWorkflowModeEnabled(mode: DynamicWorkflowMode | undefined): boolean {
  // Absence means the caller does not use mode (tests and embedders), so do not gate at the command
  // surface; the CLI entry point always passes the parsed value.
  return mode !== "disabled";
}
