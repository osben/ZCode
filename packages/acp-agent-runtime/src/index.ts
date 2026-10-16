/**
 * @zcode/acp-agent-runtime — lifecycle core for external ACP agents.
 *
 * Drives one agent process (opencode, cursor, …) over JSON-RPC stdio:
 * spawn → initialize → session/new → prompt/cancel/stop, with a typed event
 * stream, permission and fs bridges, bounded frames and process-tree teardown.
 */
export { AcpSessionRuntime } from "./runtime.js";
export type { AcpSessionRuntimeOptions } from "./runtime.js";
export { buildChildEnv, validateLaunchOptions } from "./launch.js";
export { mapSessionUpdate } from "./updates.js";
export {
  buildPermissionAsk,
  extractPermissionDetail,
  toPermissionResponse,
} from "./permissions.js";
export { readTextFileViaBridge, writeTextFileViaBridge } from "./fs.js";
export * from "./errors.js";
export type * from "./types.js";
