import { zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * The Off-Peak tool-surface gate is rollout-effective and local-workspace only. The shared pool
 * holds only local workspaces, matching the support condition; remotes stay independent, so it
 * can be cached per process. createRecord reads it uniformly for legacy create/resume, v4
 * createSession, and v4 cold recovery (subscribe → resumePersistedSession, which has no host
 * parameter channel).
 * It affects only records created/resumed afterwards; an active record's tool surface is not
 * revoked (consistent with the mid-rollout flip policy).
 */
export async function updateOffPeakToolPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.offPeakToolEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
