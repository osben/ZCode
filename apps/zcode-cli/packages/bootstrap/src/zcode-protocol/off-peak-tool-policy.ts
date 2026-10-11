import { zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * The Off-Peak tool gate (rollout active && local workspace) is a workspace-level fact. The CLI
 * process is isolated by workspace, so one cached value is sufficient. createRecord reads it for
 * legacy create/resume, v4 createSession, and v4 cold recovery (subscribe → resumePersistedSession,
 * which has no host parameter channel).
 * This affects only records created/recovered later; it does not remove tools from active records,
 * keeping behavior consistent if the rollout flag changes mid-session.
 */
export async function updateOffPeakToolPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.offPeakToolEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
