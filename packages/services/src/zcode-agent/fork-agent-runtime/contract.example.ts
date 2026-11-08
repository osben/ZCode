import { selectForkAgentRuntimeCommand } from "./contract.js";

/** The default resolver wraps its bundled Node command; storage preparation stays on that entry. */
export function exampleSelectForkAgentRuntimeCommand() {
  const nodeCommand = {
    command: process.execPath,
    args: ["zcode.cjs", "app-server", "--stdio"],
    storagePreparationEntry: "zcode.cjs",
  };
  return selectForkAgentRuntimeCommand(nodeCommand, { workspacePath: process.cwd() });
}
