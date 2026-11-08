/**
 * services-fork-agent-runtime public contract (specs/fork-agent-runtime-selection.md).
 *
 * - selectForkAgentRuntimeCommand: pure; maps the Host env frozen by Main onto the agent command.
 *   Returns the given Node command unchanged unless the env selects rust with a binary path and the
 *   Node command carries a storagePreparationEntry (which the Rust command reuses); otherwise it
 *   reports the reason through `onUnavailable` so the caller can log the downgrade.
 * - forkAgentRuntimeHelloOverrides: capability flags the Host must not claim in Rust mode; spread
 *   after both hello literals (base service and connection scope) so they cannot drift.
 * - forkAgentRuntimeCommandGateError: error code for a command whose fork feature zcode-rs lacks
 *   (execution worktree, ACP agents); undefined in Node mode.
 */
export { selectForkAgentRuntimeCommand } from "./command.js";
export type { ForkAgentRuntimeCommand, ForkRustAgentUnavailableReason } from "./command.js";
export {
  FORK_RUST_AGENT_EXECUTION_WORKTREE_UNSUPPORTED,
  FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED,
  forkAgentRuntimeCommandGateError,
  forkAgentRuntimeHelloOverrides,
  isForkRustAgentRuntime,
} from "./capabilities.js";
