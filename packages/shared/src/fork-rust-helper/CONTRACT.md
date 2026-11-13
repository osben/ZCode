# fork-rust-helper-shared

Names the Host, the CLI entry and the Rust agent share for the Rust agent's Node helper
(`specs/fork-rust-node-helper.md`, "Helper command").

- `FORK_NODE_HELPER_COMMAND_ENV` (`ZCODE_FORK_NODE_HELPER_COMMAND`): the Host sets it on the Rust
  agent to a JSON `{command, args, env}`; the Rust agent spawns exactly that command, lazily.
- `FORK_RUST_HELPER_SUBCOMMAND` (`__zcode-rust-helper`): the CLI subcommand that serves the
  forwarded methods over NDJSON stdio.

Constants only: no IO, state or dependencies. The module sits outside the package root so the CLI
entry can import it without evaluating the whole shared index.
