import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runServerCli } from "./cli.js";
import { resolveBundledAgentWiring } from "./runtime/agentWiring.js";

// Pass automatic wiring only as an explicit dependency for this CLI invocation; do not pollute the global environment.
// When starting a candidate release, Supervisor recalculates against the candidate runtime to avoid inheriting zcode.cjs from the old release.
const bundledAgentWiring = await resolveBundledAgentWiring(
  dirname(fileURLToPath(import.meta.url)),
  process.env,
);

void runServerCli(
  process.argv.slice(2),
  {
    stdout: process.stdout,
    stderr: process.stderr,
    confirm: async (prompt) => {
      process.stdout.write(prompt);
      return await new Promise<string>((resolve) => {
        process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
      });
    },
  },
  { bundledAgentWiring },
).then((exitCode) => {
  process.exitCode = exitCode;
});
