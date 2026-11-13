import { runForkRustHelper } from "./contract.js";

/** The CLI entry runs the helper on its own stdio; the Rust agent owns both ends. */
export async function exampleRunForkRustHelper() {
  await runForkRustHelper({ input: process.stdin, output: process.stdout, env: process.env });
}
