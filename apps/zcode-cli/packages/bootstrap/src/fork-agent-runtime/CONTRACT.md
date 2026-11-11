# cli-fork-agent-runtime

CLI-side half of the Node/Rust agent selection (`specs/fork-agent-runtime-selection.md`, rule 3): the Node storage-preparation Worker lays out the official plugin store that `zcode-rs` only reads.

Invariants:

- Rust only: it acts only when the Worker env has `ZCODE_FORK_AGENT_RUNTIME=rust` (Main → Host env → Worker env). In Node mode the Node agent stays the only seeder.
- It runs after `startup/storagePrepared` and before the Worker exits, so the Host's first-frame timer never waits on it, and the agent spawn, which waits for the exit, sees a seeded store.
- It never fails storage preparation: errors are logged at `warn`. It writes nothing to stdout, the Host's control channel.
- The store root is the one the Rust agent reads (`StoragePaths::plugin_storage`): the merged `storage.dir`, `~/` expanded, a relative path resolved against the workspace.
- Wiring point: the `prepareStorageOnly` branch of `runZCodeProtocolAgent` (`zcode-protocol-entrypoint.ts`, fork patch).
