/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export { createNodeNetworkCapture, withoutNetworkCapture } from "./node/networkCapture.js";
export {
  GEN_UI_OUTPUT_ROOT_ENV,
  GEN_UI_OUTPUT_DIRECTORY,
  getGenUiOutputDirectory,
} from "./node/genUiPaths.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWriteFile,
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type AtomicWriteFileOptions,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  getClaudeUserInstructionsFilePath,
  getUserZcodeAgentsFilePath,
  resolveAgentUserHomeDir,
} from "./node/userInstructionsPaths.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";

export * from "./node/process-tree/processTreeSnapshot.js";
export * from "./node/process-tree/processTreeTypes.js";
export * from "./node/process-tree/processTreeTerminator.js";
export * from "./node/process-tree/processTreeOwnership.js";
export * from "./node/process-tree/windowsProcessListAsync.js";
export * from "./node/process-tree/windowsTaskkillRunner.js";
export * from "./node/process-tree/processTreeSnapshotAsync.js";
export * from "./node/process-tree/processTreeWaiter.js";
export { RefreshSingleflight } from "./node/refreshSingleflight.js";
