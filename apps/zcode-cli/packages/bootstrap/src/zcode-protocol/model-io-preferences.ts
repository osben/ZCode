import { zcodeWorkspaceUpdateModelIoPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * ModelIO persistence policy is an app-wide preference, but every resident session owns a separate
 * adapter. The protocol layer caches the preference for future sessions and updates existing sessions
 * immediately, preventing old and new tasks from behaving differently.
 */
export async function updateModelIoPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateModelIoPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.fullRetentionEnabled;
  context.appRuntimePreferences.modelIoFullRetentionEnabled = enabled;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.setModelIoFullRetentionEnabled) continue;
    record.app.setModelIoFullRetentionEnabled(enabled);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    fullRetentionEnabled: enabled,
    updatedSessionCount,
  };
}
