import { FORK_AGENT_RUNTIME_ENV, FORK_RUST_AGENT_PATH_ENV } from "@zcode/shared";
import {
  FORK_NODE_HELPER_COMMAND_ENV,
  FORK_RUST_HELPER_SUBCOMMAND,
} from "@zcode/shared/fork-rust-helper";

/** Structural subset of the process manager's ZCodeAgentCommand this selection reads and returns. */
export interface ForkAgentRuntimeCommand {
  storagePreparationEntry?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Why a rust selection still runs the Node command; the caller logs it (rule 4: no silent fallback). */
export type ForkRustAgentUnavailableReason = "binary_path_missing" | "no_node_bundle";

/**
 * Fork agent runtime selection, Host side (specs/fork-agent-runtime-selection.md).
 *
 * Main is the only decision-maker: it writes the effective runtime and, for rust, the binary path
 * into the Host env before the Host starts. This function only maps that frozen env onto a command,
 * so storage preparation and the agent spawn (both go through resolveDefaultZCodeAgentCommand)
 * always see the same decision.
 *
 * The Rust agent is the conversation process only. Storage preparation keeps the bundled Node
 * entry, which owns every migration including the fork `9001_fork_*` ones; without a Node bundle
 * there is no Rust command, because the Rust agent would open an unmigrated database.
 */
export function selectForkAgentRuntimeCommand<T extends ForkAgentRuntimeCommand>(
  nodeCommand: T | null,
  context: { workspacePath: string },
  env: NodeJS.ProcessEnv = process.env,
  onUnavailable?: (reason: ForkRustAgentUnavailableReason) => void,
): T | ForkAgentRuntimeCommand | null {
  if (env[FORK_AGENT_RUNTIME_ENV]?.trim() !== "rust") return nodeCommand;
  const rustAgentPath = env[FORK_RUST_AGENT_PATH_ENV]?.trim();
  if (!rustAgentPath) {
    onUnavailable?.("binary_path_missing");
    return nodeCommand;
  }
  // The dev source-tree command (tsx) and a missing bundle carry no storage entry: Main cannot see
  // which Node command the Host resolves, so the Host reports the downgrade instead.
  const storagePreparationEntry = nodeCommand?.storagePreparationEntry;
  if (!nodeCommand || !storagePreparationEntry) {
    onUnavailable?.("no_node_bundle");
    return nodeCommand;
  }
  // The Rust agent forwards JS-only methods to a Node helper (specs/fork-rust-node-helper.md). It
  // runs the same bundled entry the storage preparation uses, so both runtimes share one plugin
  // store and one database; the Rust agent spawns it lazily and owns its lifecycle.
  const nodeHelperCommand = {
    command: nodeCommand.command,
    args: [storagePreparationEntry, FORK_RUST_HELPER_SUBCOMMAND, "--stdio"],
    env: nodeCommand.env ?? {},
  };
  return {
    command: rustAgentPath,
    args: ["app-server", "--stdio"],
    cwd: context.workspacePath,
    env: { [FORK_NODE_HELPER_COMMAND_ENV]: JSON.stringify(nodeHelperCommand) },
    storagePreparationEntry,
  };
}
