# Rust agent parity (zcode-rs as the desktop conversation agent)

Status: in progress. Tracking file for bringing `zcode-rs` (`packages/rust-cli`) to parity with the Node agent for everything the desktop UI drives. Runtime selection, storage preparation and the Host gate are specified in `specs/fork-agent-runtime-selection.md`; this file owns the parity matrix, the verification gate and the order of work.

## Goal

With `agentRuntime: rust` the desktop behaves and looks the same as with Node: every desktop flow that works on Node works on Rust, with the same rows, cards, panels and errors on screen, and the same records in the shared `db.sqlite`. The UI, Host and Main are unchanged; only the conversation agent process differs.

## Definition of "1:1"

A feature is at parity when all of these hold:

1. **Desktop E2E.** Every desktop E2E spec covering it that passes on Node also passes with `ZCODE_E2E_AGENT_RUNTIME=rust` (same spec, same replay fixtures, no Rust-only branches in the spec). The E2E specs assert on the rendered UI, so a pass is the visual 1:1 check for that flow.
2. **No protocol gaps on the path.** The Rust agent log of that run has no `protocol.method.unsupported` or `protocol.command.unsupported` event for the flow.
3. **Shared storage.** Records written by one runtime are read correctly by the other (cross-runtime reopen), checked by a test where the feature persists state.
4. **Rust gates.** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo nextest run --workspace` pass (the PR check job).

## How gaps are found

- `zcode-rs` logs every request it does not serve at `info`: `protocol.method.unsupported` (method name) and `protocol.command.unsupported` (v4 command kind). The log carries names only, never params.
- The desktop E2E suite runs with `ZCODE_E2E_AGENT_RUNTIME=rust` and `ZCODE_FORK_RUST_AGENT_PATH=<binary>`. The Rust agent log lands in the E2E home (`.zcode/rust-cli/log/*.jsonl`); Host logs in `.e2e-artifacts/<run>/runtime-logs`.
- A spec that fails on Rust and passes on Node is a parity gap. A spec that fails on both is not counted.

## Out of scope (stay on Node or stay refused)

These are JavaScript by nature or tied to Node-only runtimes. In Rust mode they are refused with a stable code or hidden by a capability flag, never silently dropped. Listed here so the matrix does not count them as gaps:

- JS plugin runtimes and plugin UI surfaces (`plugins/*`, `mcp/ui*`) beyond what `zcode-rs` `ext` already serves.
- Dynamic workflows (`workflows/*`, `v4/conversation/workflowRun*`, `startSavedWorkflow`, `resumeWorkflowRun`, `amendWorkflowRunSettings`).
- Office runtime, node-repl host.
- ACP external agents (decision pending with the owner).
- ChatGPT Plan account access (needs a live account to verify).

## Parity matrix

Filled from the Rust E2E run; one row per method family or command group. Status: `gap`, `done` (all four checks), `refused` (out of scope, stable code).

| Area                                                                       | Node owner                                                       | Rust status                                                                                                                                                                                             | Verified by                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Shared task runtime routing (`sessionWorkspaceRouting`)                    | `bootstrap/zcode-protocol/server.ts`                             | done: capability reported; requests are routed by `sessionId` and per-workspace topics                                                                                                                  | `conversation-session-first-send`                                                                 |
| `renameSession`, `switchModelConfig`, `switchCollaborationMode`, `compact` | `handlers/session-mgmt.ts`, `model-config.ts`, `goal-compact.ts` | ported (`fork/session_config.rs`): kernel `Rename`, `SetModel`, `SetMode`/`SetPlan`, `Compact`; a switch to the value in effect is `noop` `config.unchanged`                                            | gate: `v4-rename`, `v4-model-switch`, `model-config`, `v4-compact`, `compact`, `v4-plan-shortcut` |
| Row actions (`canEdit`/`editDisposition`, `canRetry`, `canFork`)           | `product-projection.ts` `materializeCommandRowActions`           | ported (`projection/actions.rs`), same rules; `canRewindFiles` not yet (no turn file changes in the projection)                                                                                         | unit tests; gate: `v4-edit`, `v4-fork`                                                            |
| `editUserQuery`, `retryTurn`, `forkAssistant`                              | `handlers/fork-edit-retry.ts`                                    | ported (`fork/row_commands.rs`): edit and retry are kernel `Rewind{conversation}` + resubmit (edit preempts a running turn like Node); fork is `ForkFromInput`. `workspaceMode: rewind` (files) not yet | gate: `v4-edit`, `v4-fork`, `v4-fork-edit-branch`                                                 |
| History rewrite (`HistoryRewritten`)                                       | Node `RewindTriggered` projection                                | the projection is rebuilt from a fresh view and every started subscription gets a new snapshot (`live.rs`), like the TUI                                                                                | `v4-edit`                                                                                         |

## Gate

The PR gate is the curated spec list below, run one spec at a time (`pnpm test:e2e -- --spec <file>` with `ZCODE_E2E_AGENT_RUNTIME=rust`), never with `ZCODE_E2E_MAX_INSTANCES>1` on the shared `.e2e-home` (workers wipe each other's HOME). A failing gate spec is rerun under Node: a failure on both runtimes is not a parity gap.

`first-send`, `send-message-resume-stop`, `stop-empty`, `stop-tool-results`, `v4-vertical-slice`, `v4-permission`, `permission-full-access`, `ask-user-question-keyboard-navigation`, `v4-model-switch`, `model-config`, `v4-rename`, `v4-compact`, `compact`, `v4-edit`, `v4-fork`, `v4-rewind-files`, `v4-delete`, `v4-queue`, `queue-operations`, `running-queue`, `v4-sendnow`, `v4-attachment`, `attachment-resume`, `v4-goal`, `tool-actions`, `bash-direct-output`, `v4-plan-shortcut`, `plan-mode-capabilities`, `v4-input-control`, `v4-load-older`, `context-window-cold-resume`, `tool-history-order`, `v4-stop-queue`, `interrupted-actions` (all under `test/e2e/conversation-session/conversation-session-*.test.ts`).

The default runtime stays `node`, so specs outside the gate keep their Node behaviour; the matrix lists the gaps that remain.

## Order of work

1. Gap discovery run (all `conversation-session` specs, then settings, ui-shell, plugins).
2. Command kinds the kernel already has: `switchModelConfig`, `switchCollaborationMode`, `compact`, `forkAssistant`, `applyFileRewind`, `editUserQuery`, `retryTurn`, `renameSession`.
3. Agent-owned state without kernel support yet: queue operations, `deleteSession`, goals, feedback and pins, hook review, plan state, usage, file changes.
4. Fork features: incognito, execution worktree, usage rollup, draft cleanup.
5. Packaging the binary in `fork-release.yml` (macOS arm64, Windows x64) with the Apache-2.0 `LICENSE`/`NOTICE`.
6. Default runtime stays `node` until every in-scope row is `done`; flipping it is a separate change backed by a full Rust E2E run.
