/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
import { userInfo } from "node:os";

/**
 * Display name of the OS user running the server; a container's numeric UID
 * has no passwd entry, and `userInfo()` would otherwise abort Core startup.
 * This field is display-only: fall back to the effective UID to keep the
 * "OS user" semantics; every other failure is still the caller's problem.
 */
export function resolveServerOsUser(): string {
  try {
    return userInfo().username;
  } catch (error) {
    if (
      error instanceof Error &&
      "info" in error &&
      typeof error.info === "object" &&
      error.info !== null &&
      "code" in error.info &&
      error.info.code === "ENOENT" &&
      "syscall" in error.info &&
      error.info.syscall === "uv_os_get_passwd" &&
      typeof process.geteuid === "function"
    ) {
      return `uid:${process.geteuid()}`;
    }
    throw error;
  }
}

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
  hashBytes,
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
export {
  DEFAULT_OAUTH_CALLBACK_APP_URL,
  buildOAuthCallbackPage,
  isSafeAppUrl,
  renderOAuthCallbackPage,
  respondWithOAuthCallbackPage,
  type OAuthCallbackFlow,
  type OAuthCallbackOutcome,
  type OAuthCallbackPageOptions,
  type OAuthCallbackSurface,
  type RenderedOAuthCallbackPage,
} from "./node/oauthCallbackPage.js";
