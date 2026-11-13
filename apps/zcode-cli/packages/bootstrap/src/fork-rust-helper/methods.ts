import { zcodeProtocolMethods } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

/** Version of the Rust ↔ helper protocol (`helper/initialize`). */
export const FORK_RUST_HELPER_PROTOCOL_VERSION = 1;

export const FORK_RUST_HELPER_INITIALIZE = "helper/initialize";

/**
 * The F1+F2 methods the helper serves (specs/fork-rust-node-helper.md, "F1+F2 forwarded methods").
 * Rust forwards a method only if it is in its own static allowlist and in this list.
 */
export const FORK_RUST_HELPER_METHODS = [
  zcodeProtocolMethods.pluginsList,
  zcodeProtocolMethods.pluginsOverview,
  zcodeProtocolMethods.pluginsDescribe,
  zcodeProtocolMethods.pluginsInstall,
  zcodeProtocolMethods.pluginsUninstall,
  zcodeProtocolMethods.pluginsUpdate,
  zcodeProtocolMethods.pluginsSetEnabled,
  zcodeProtocolMethods.pluginsConfigure,
  zcodeProtocolMethods.pluginsResetConfig,
  zcodeProtocolMethods.pluginsValidate,
  zcodeProtocolMethods.pluginsRestoreBuiltin,
  zcodeProtocolMethods.pluginsMarketplaceAdd,
  zcodeProtocolMethods.pluginsMarketplaceRemove,
  zcodeProtocolMethods.pluginsMarketplaceUpdate,
  zcodeProtocolMethods.pluginsResolveSuggestedReference,
  zcodeProtocolMethods.pluginsCancelOperation,
  zcodeProtocolMethods.pluginsReadUserOptions,
  zcodeProtocolMethods.pluginsListUiSurfaces,
  zcodeProtocolMethods.pluginsReferenceCatalog,
  zcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
  zcodeProtocolMethods.workflowsList,
  zcodeProtocolMethods.workflowsGet,
  zcodeProtocolMethods.workflowsUpdateMeta,
  zcodeProtocolMethods.workflowsDelete,
  zcodeProtocolMethods.workflowsRuns,
  zcodeProtocolMethods.workflowsMove,
  zcodeProtocolMethods.workflowsSave,
  zcodeProtocolMethods.workflowsForRun,
  V4_METHODS.conversationWorkflowRuns,
  V4_METHODS.conversationWorkflowRunEvents,
  V4_METHODS.conversationWorkflowRunArtifacts,
  V4_METHODS.conversationWorkflowRunArtifactData,
  V4_METHODS.conversationWorkflowRunArtifactRead,
  V4_METHODS.conversationWorkflowRunWorkspace,
  V4_METHODS.conversationWorkflowRunNodeResult,
] as const;
