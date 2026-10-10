import { zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema } from "@zcode/shared";
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
  return { workspace: params.workspace, enabled: params.enabled };
}
