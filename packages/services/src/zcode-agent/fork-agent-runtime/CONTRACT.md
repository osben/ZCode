# services-fork-agent-runtime

Host-side half of the Node/Rust agent selection (`specs/fork-agent-runtime-selection.md`). Main decides; this module only reads the frozen Host env.

Invariants:

- Pure and synchronous: `resolveDefaultZCodeAgentCommand` calls it for both storage preparation and the agent spawn, so both see one decision.
- The Rust command is the conversation process only; it reuses the Node command's `storagePreparationEntry`, so migrations (fork `9001_fork_*` included) stay on Node.
- No Node storage entry or no binary path → the Node command is returned unchanged.
- `ZCODE_AGENT_SERVER_COMMAND` is handled before this hook and bypasses it.
- Wiring point: `resolveDefaultZCodeAgentCommand` (`zcodeAgentProcessManager.ts`).
