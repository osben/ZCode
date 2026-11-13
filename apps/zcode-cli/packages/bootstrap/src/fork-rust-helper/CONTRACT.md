# cli-fork-rust-helper

The Node helper of the Rust agent (`specs/fork-rust-node-helper.md`): the `__zcode-rust-helper --stdio` subcommand of the CLI bundle. In Rust mode, `zcode-rs` starts it lazily and forwards to it only the methods that need Node code.

Invariants:

- Rust stays the single owner of conversations. The helper's context refuses to create a session app, has no sessions and no Host client. Run history is read from the journal directly: never through the run service (its constructor reconciles orphan runs, a journal write) and never by cold-resuming a session.
- Every forwarded call carries its own `workspace`; the helper is never bound to one. It resolves the storage root, the plugin store and the session database from the env and config exactly as a Node agent would.
- It runs no storage preparation. The session store is opened on the first saved-workflow or run-history call; opening it runs Node's idempotent migration check, a no-op on the database the Host Worker prepared.
- Same server behaviour as Node for the forwarded handlers: the `operationId` abort map behind `plugins/cancelOperation`, and plugin cache invalidation after each plugin mutation.
- stdout is the protocol channel: NDJSON frames only. Notifications go out under their Host method names; Rust relays only its own allowlist.
- Wiring point: `cli/src/main.ts` checks `__zcode-rust-helper` before importing the full CLI.
