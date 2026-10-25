import {
  zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * Dynamic workflow rollout gate. The Host owns the decision:
 * it reads `dynamicWorkflow.mode` from `/client/configs`, while the CLI caches only the result and
 * never reads the feature key or local override environment variables. Like off-peak-tool-policy.ts,
 * the CLI process is isolated by workspace and needs only one cached value. createRecord reads the
 * same value for legacy create/resume, v4 createSession, and v4 cold recovery (subscribe →
 * resumePersistedSession, which has no host parameter channel).
 * This affects only records created/recovered later; it does not remove tools from active records,
 * keeping the behavior consistent if the rollout flag changes mid-session.
 */
export async function updateDynamicWorkflowPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.dynamicWorkflowEnabled = params.enabled;
  // mode is meaningful only when enabled; clear it when disabled so the next enable (from a
  // boolean-only legacy Host) does not carry over a stale onDemand.
  context.appRuntimePreferences.dynamicWorkflowMode = params.enabled ? params.mode : undefined;
  return { workspace: params.workspace, enabled: params.enabled };
}

/** The two rollout fields createRecord writes into runtimeConfig (launch.md "On demand: activation" and "How the mode travels"). */
export interface DynamicWorkflowRuntimeGate {
  dynamicWorkflowEnabled: boolean;
  dynamicWorkflowToolsOnDemand: boolean;
}

/**
 * The create / resume parameters take precedence; when absent, fall back to the workspace-level
 * conclusion the Host synced into the process; with neither, the gate is closed (fail-closed).
 * mode resolves in the same order, defaulting to alwaysOn when both are absent — matching a
 * boolean-only legacy Host with today's behavior. Both fields **must be written as explicit
 * booleans**: core defines "absent" as "not participating in the rollout, register all tools
 * immediately" (the TUI / headless / workflow_child semantics), and sessions created by a
 * trusted Host must not fall into that exemption.
 */
export function resolveDynamicWorkflowRuntimeGate(
  params: { dynamicWorkflowEnabled?: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
  preferences: { dynamicWorkflowEnabled: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
): DynamicWorkflowRuntimeGate {
  const enabled = params.dynamicWorkflowEnabled === true || preferences.dynamicWorkflowEnabled;
  if (!enabled) return { dynamicWorkflowEnabled: false, dynamicWorkflowToolsOnDemand: false };
  const mode = params.dynamicWorkflowMode ?? preferences.dynamicWorkflowMode ?? "alwaysOn";
  return { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: mode === "onDemand" };
}
