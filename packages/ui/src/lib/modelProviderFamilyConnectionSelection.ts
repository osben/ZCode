import type {
  EnterpriseCodingPlanPricingProduct,
  ProviderFamilyConnectionSelection,
  ProviderFamilyDomain,
  UsageEntitlementSnapshot,
} from "@zcode/shared";
import { getModelProviderFamilySpec } from "@zcode/shared";
import { hasActiveUsageEntitlementSnapshot } from "@/lib/codingPlanProvider.js";

export type ModelProviderFamilyConnectionSelection = ProviderFamilyConnectionSelection;

/** Map the current Family connection intent to the corresponding Built-in Account Provider identity. */
export function resolveModelProviderFamilyConnectionProviderId(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  selection: ProviderFamilyConnectionSelection;
}): string {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);
  switch (params.selection.kind) {
    case "start-plan":
      return familySpec.startPlanProviderId;
    case "individual-coding-plan":
      return familySpec.individualCodingPlanProviderId;
    case "team-coding-plan":
      return familySpec.teamCodingPlanProviderId;
  }
}

export function resolveFirstSubscribedTeamPlanConnectionWithContext(params: {
  teamProducts: readonly EnterpriseCodingPlanPricingProduct[];
}): Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }> | null {
  for (const product of params.teamProducts) {
    if (product.subscribed !== true) continue;
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? "",
              projectId: product.projectId ?? "",
              apiKeyStatus: product.apiKeyStatus,
            },
          ];
    for (const projectContext of projectContexts) {
      if (projectContext.apiKeyStatus === "unavailable") continue;
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) continue;
      return {
        kind: "team-coding-plan",
        productId: product.productId,
        organizationId,
        projectId,
      };
    }
  }
  return null;
}

export function resolveAutomaticModelProviderFamilyConnectionSelection(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  codingPlanEntitlement: UsageEntitlementSnapshot | null;
  startPlanEntitlement: UsageEntitlementSnapshot | null;
  teamProducts?: readonly EnterpriseCodingPlanPricingProduct[];
  /** For first sign-in, the selection may lead to a purchase entry; when repairing an existing connection, choose only a confirmed-available plan. */
  allowPurchaseEntry?: boolean;
  /** The unified current Account View takes precedence over stale balance snapshots, especially when distinguishing pending from available. */
  codingPlanAvailable?: boolean;
  startPlanAvailable?: boolean;
}): ModelProviderFamilyConnectionSelection | null {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);

  if (
    params.codingPlanAvailable ??
    hasActiveUsageEntitlementSnapshot(
      params.codingPlanEntitlement,
      familySpec.individualCodingPlanProviderId,
    )
  ) {
    return {
      kind: "individual-coding-plan",
    };
  }

  // The original guard familySpec.id === "bigmodel" prevented recognizing zai even when it had a subscribed team.
  // After removing the guard, both Provider Families read the structured team selection uniformly.
  const teamSelection = resolveFirstSubscribedTeamPlanConnectionWithContext({
    teamProducts: params.teamProducts ?? [],
  });
  if (teamSelection) return teamSelection;

  if (params.allowPurchaseEntry === false) return null;
  // The input connection method after OAuth sign-in must always retain OAuth semantics.
  // Even if the current account has no Start, individual Coding, or team Coding plan, route it to the individual Coding entry,
  // and let the later purchase/unavailable state handle it rather than automatically switching to API Key.
  return {
    kind: "individual-coding-plan",
  };
}
