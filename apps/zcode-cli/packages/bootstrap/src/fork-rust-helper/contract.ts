/**
 * cli-fork-rust-helper public contract (specs/fork-rust-node-helper.md).
 *
 * - runForkRustHelper: the `__zcode-rust-helper --stdio` subcommand. Serves the forwarded F1+F2
 *   methods (plugin management, saved workflows, run history) to the Rust agent over NDJSON stdio,
 *   on a sessionless context. Resolves when stdin closes.
 * - FORK_RUST_HELPER_PROTOCOL_VERSION / FORK_RUST_HELPER_METHODS: the `helper/initialize` answer.
 */
export { runForkRustHelper, type RunForkRustHelperOptions } from "./runtime.js";
export { FORK_RUST_HELPER_METHODS, FORK_RUST_HELPER_PROTOCOL_VERSION } from "./methods.js";
