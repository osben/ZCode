import { describeAcpLaunchProblem } from "./contract.js";

/** A valid launch: a detected agent binary in ACP mode with one harmless override. */
export const exampleAcpLaunch = {
  command: "/usr/local/bin/opencode",
  args: ["acp"],
  env: { OPENCODE_CONFIG: "/Users/example/.config/opencode/opencode.json" },
} as const;

export const exampleAcpLaunchProblem: string | null = describeAcpLaunchProblem(exampleAcpLaunch);
