# services-fork-agent-runtime

Host-side half of the Node/Rust agent selection (`specs/fork-agent-runtime-selection.md`). Main decides; this module only reads the frozen Host env.

Invariants:

- Pure and synchronous: `resolveDefaultZCodeAgentCommand` calls it for both storage preparation and the agent spawn, so both see one decision.
- The Rust command is the conversation process only; it reuses the Node command's `storagePreparationEntry`, so migrations (fork `9001_fork_*` included) stay on Node.
- No Node storage entry or no binary path → the Node command is returned unchanged.
- `ZCODE_AGENT_SERVER_COMMAND` is handled before this hook and bypasses it.
- Wiring point: `resolveDefaultZCodeAgentCommand` (`zcodeAgentProcessManager.ts`).
- The Rust command carries `ZCODE_FORK_NODE_HELPER_COMMAND`: JSON `{command, args, env}` that runs the same bundled Node entry as `__zcode-rust-helper --stdio` (specs/fork-rust-node-helper.md). The Rust agent spawns it lazily; the Host never starts it.
