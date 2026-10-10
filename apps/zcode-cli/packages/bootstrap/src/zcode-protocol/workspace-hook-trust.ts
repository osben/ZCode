import { resolve } from "node:path";
import { workspaceHookPolicySchema } from "@zcode/contracts";
import type { WorkspaceHookPolicyProvider } from "@zcode/core";
import {
  zcodeWorkspaceHookTrustGrantParamsSchema,
  zcodeWorkspaceHookTrustGrantReasonCodeSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
  type ZCodeWorkspaceHookTrustGrantReasonCode,
  type ZCodeWorkspaceHookTrustGrantResult,
} from "@zcode/shared";
import {
  grantWorkspaceHookTrust,
  type WorkspaceHookTrustCliStatus,
} from "../workspace-hook-trust-cli.js";

type GrantWorkspaceHookTrust = typeof grantWorkspaceHookTrust;

/**
 * Workspace-level Trust authority when there is no task/session.
 *
 * A trusted Host may submit only the exact bundle/declaration shown in Settings; before granting
 * authorization, the Agent rediscovers the canonical snapshot. This does not create a hidden task
 * or accept records supplied directly by the UI.
 */
export async function grantWorkspaceHookTrustForProtocol(
  rawParams: unknown,
  dependencies: {
    appVersion?: string;
    grant?: GrantWorkspaceHookTrust;
    policyProvider: WorkspaceHookPolicyProvider;
  },
): Promise<ZCodeWorkspaceHookTrustGrantResult> {
  const params = zcodeWorkspaceHookTrustGrantParamsSchema.parse(rawParams);
  const grant = dependencies.grant ?? grantWorkspaceHookTrust;
  const workspaceIdentity =
    params.workspace.workspaceIdentity?.trim() || resolve(params.workspace.workspacePath);
  const policyRejection = getPolicyRejectionReason(
    dependencies.policyProvider,
    workspaceIdentity,
  );
  if (policyRejection) {
    return zcodeWorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: policyRejection,
    });
  }
  try {
    const status = await grant({
      workspacePath: params.workspace.workspacePath,
      ...(params.workspace.workspaceIdentity
        ? { workspaceIdentity: params.workspace.workspaceIdentity }
        : {}),
      bundleDigest: params.bundleDigest,
      hookDeclarationDigests: [params.hookDeclarationDigest],
      ...(dependencies.appVersion ? { appVersion: dependencies.appVersion } : {}),
    });
    return zcodeWorkspaceHookTrustGrantResultSchema.parse(
      didGrantExactDeclaration(status, params.hookDeclarationDigest)
        ? { accepted: true }
        : { accepted: false, reasonCode: toPublicReasonCode(status.reasonCode) },
    );
  } catch (error) {
    return zcodeWorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: toPublicReasonCode(error),
    });
  }
}

function getPolicyRejectionReason(
  policyProvider: WorkspaceHookPolicyProvider,
  workspaceIdentity: string,
): ZCodeWorkspaceHookTrustGrantReasonCode | undefined {
  try {
    const policy = workspaceHookPolicySchema.parse(
      policyProvider.getPolicy(workspaceIdentity),
    );
    if (policy.mode === "user_decides") return undefined;
    return policy.mode === "allow_trusted_only"
      ? "workspace_hooks_policy_requires_pretrust"
      : "workspace_hooks_blocked_by_policy";
  } catch {
    // The Settings no-session path used to write directly to the Trust store after rediscovery,
    // bypassing the trusted embedder policy. Fail closed if the policy provider throws; do not fall
    // back to default authorization.
    return "workspace_hooks_blocked_by_policy";
  }
}

function toPublicReasonCode(error: unknown): ZCodeWorkspaceHookTrustGrantReasonCode {
  const candidate = error instanceof Error ? error.message : error;
  const parsed = zcodeWorkspaceHookTrustGrantReasonCodeSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // This previously put the underlying Error.message directly into reasonCode, allowing absolute
  // configuration paths and usernames to cross the Agent/Host/UI protocol boundary. Unknown
  // exceptions must map to a stable public code; do not pass their text through.
  return "workspace_hooks_config_unreadable";
}

function didGrantExactDeclaration(
  status: WorkspaceHookTrustCliStatus,
  hookDeclarationDigest: string,
): boolean {
  return status.items.some(
    (item) =>
      item.hookDeclarationDigest === hookDeclarationDigest &&
      item.trustState === "trusted_persistent",
  );
}
