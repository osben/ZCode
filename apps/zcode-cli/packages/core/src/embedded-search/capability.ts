// Enter the provider-visible embedded search branch by default. The execution layer controls injection of the Bash find/grep prelude;
// do not change the tool/prompt surface seen by the model just because the current shell does not support function injection.
const ENABLE_EMBEDDED_SEARCH_BRANCH = true;

export interface EmbeddedSearchBranchCapabilityContext {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
}

export type EmbeddedSearchBranchCapabilityReason =
  | "supported"
  | "disabled_by_global_flag"
  | "bash_unavailable";

export interface EmbeddedSearchBranchCapabilityDecision {
  reason: EmbeddedSearchBranchCapabilityReason;
  useEmbeddedSearchBranch: boolean;
}

export function evaluateEmbeddedSearchBranchCapability(
  context: EmbeddedSearchBranchCapabilityContext,
): EmbeddedSearchBranchCapabilityDecision {
  const branchEnabled = context.embeddedSearchBranchEnabled ?? ENABLE_EMBEDDED_SEARCH_BRANCH;

  if (!branchEnabled) {
    return {
      reason: "disabled_by_global_flag",
      useEmbeddedSearchBranch: false,
    };
  }

  if (!context.bashAvailable) {
    return {
      reason: "bash_unavailable",
      useEmbeddedSearchBranch: false,
    };
  }

  return {
    reason: "supported",
    useEmbeddedSearchBranch: true,
  };
}

export function resolveEmbeddedSearchBranchCapability(input: {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
}): EmbeddedSearchBranchCapabilityDecision {
  return evaluateEmbeddedSearchBranchCapability({
    bashAvailable: input.bashAvailable,
    embeddedSearchBranchEnabled: input.embeddedSearchBranchEnabled,
  });
}
