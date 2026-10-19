import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getExePath } = require("lefthook/get-exe");
const args = process.argv.slice(2);
// lint-staged owns partial staging and rollback. Do not let Lefthook hide the
// same edits first: its restore-conflict path can leave them only in a stash.
if (args[0] === "run" && args[1] === "pre-commit") args.push("--no-stage-fixed");
const child = spawn(getExePath(), args, { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Unable to run Lefthook: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
