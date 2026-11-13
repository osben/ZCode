// Fork-owned: how the Rust agent starts its Node helper (specs/fork-rust-node-helper.md). Kept out of
// the package root so the CLI entry can read it without evaluating the whole shared index.

/**
 * The Host writes a JSON `{command, args, env}` here when it selects the Rust runtime and a bundled
 * Node entry exists; the Rust agent spawns exactly that command when a forwarded method first needs it.
 */
export const FORK_NODE_HELPER_COMMAND_ENV = "ZCODE_FORK_NODE_HELPER_COMMAND";

/** CLI subcommand that runs the Node helper over NDJSON stdio. */
export const FORK_RUST_HELPER_SUBCOMMAND = "__zcode-rust-helper";
