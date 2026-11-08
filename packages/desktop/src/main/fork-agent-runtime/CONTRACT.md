# desktop-fork-agent-runtime

Main-side choice between the Node and the Rust (`zcode-rs`) agent. Rules and event order are in `specs/fork-agent-runtime-selection.md`.

Invariants:

- One decision per app process. It is resolved inside `awaitFirstHostSpawnDecision` before the first Host fork and is never re-read, so a settings change applies after restart and windows never mix runtimes.
- Precedence: `ZCODE_FORK_AGENT_RUNTIME` from the shell (`node|rust`; anything else is ignored with a warn), then the fork setting `agentRuntime`, then `node`.
- `rust` is effective only when a `zcode-rs` binary is found (explicit `ZCODE_FORK_RUST_AGENT_PATH`, `<resources>/zcode-rs/`, dev `packages/desktop/resources/zcode-rs/`); otherwise `node` with a single warn. Never under `resources/glm`.
- Main is the only writer of `ZCODE_FORK_AGENT_RUNTIME` / `ZCODE_FORK_RUST_AGENT_PATH` in the Host env: inherited values are deleted first.
- Wiring points: `awaitFirstHostSpawnDecision` (`index.ts`) and `spawnHostProcess` (`desktopHostProcess.ts`).
