# Removing the Node agent (fork)

Status: plan, decided 2026-11-28. Nothing removed yet. The S items closed on 2026-11-28 (#652 to #655); the automations item is open and now sized M.

Goal: the desktop app runs only the Rust agent (`zcode-rs`, `packages/rust-cli`), and the Node agent runtime in
`apps/zcode-cli` is deleted. Node stays the reference until the gate below passes.

## Decision: the Node helper stays

The Node helper (`__zcode-rust-helper`, [fork-rust-node-helper.md](fork-rust-node-helper.md)) stays as a separate
small Node process after the agent is removed. It keeps the families Rust reaches only through it: plugin management
(F1), saved workflows and run history reads (F2), the Office runtime, helper-hosted MCP servers and MCP Apps (F3), the
`node_repl` host and the browser broker (F4), and the computer-use relay (F6). Porting those to Rust is out of scope.

Consequences:

- The helper bundle also keeps the jobs the Host runs from the Node bundle today: storage preparation and migrations
  (`storagePreparationEntry`, [fork-agent-runtime-selection.md](fork-agent-runtime-selection.md)) and seeding the
  official plugin cache (`bootstrap/src/app/bundled-plugins.ts`). Rust only reads that cache.
- "Delete Node" means: delete the Node agent runtime path and the code only it uses. The helper entry point and the
  packages it imports stay. The official plugin sources under `apps/zcode-cli/packages` stay until they have a home
  outside the agent.
- Plugin reload for the process root (open item from the 2026-11-27 round): a process-wide re-select, as Node does.
  No second layer slot for the process workspace, since duplicate stdio MCP children made the OAuth E2E fragile.
- A PluginHost plugin without a helper (TUI, `-p`) stays skipped. Low priority: the desktop always has the helper.

## Gaps to close before the switch

Sizes: S is under a day, M is a few days, L is a week or more. Sources are the parity spec and the feature specs.

| Item                                                                                                                    | Size |
| ----------------------------------------------------------------------------------------------------------------------- | ---- |
| Done (#655): execution worktree section in the model context and the subagent `<env>` block                             | S    |
| Done (#654): ListModels tool                                                                                            | S    |
| Hook input fields `traceId`, `turnId`, `riskLevel`, `sideEffectScope`, token counts, from Node's sources and risk table | M    |
| Done (#654): model retry env vars and Node's Retry-After rules                                                          | S    |
| Done (#652): CUA skill rules (`cuaPolicy`) for subagents                                                                | S    |
| Done (#653): user fallback `~/.agents/mcp.json`, `MCP_TIMEOUT` on the settings lane, retired CUA MCP filter             | S    |
| `SendMessage` resume kept across a second rewind (store query, no schema change)                                        | M    |
| Memory: recall, extraction and dream                                                                                    | L    |
| Microcompaction                                                                                                         | M    |
| Topic resources: `ReplyToChannel`, bot source guidance, group task permission scope                                     | M    |
| Imported history: `sharedContext`, `removePreviousImportedSessionHistory`                                               | M    |
| Off-peak layer B: `v4/offPeak/lifecycle`, `offPeakControl`, `startNow` with off-peak, `activeOffPeakTaskId` guard       | M    |
| Automations: Host `toolSearchMode`, `AutomationCreateLimitError` recovery (remote workspace gate done in #652)          | M    |
| LSP runtime in TUI and `-p`                                                                                             | M    |
| Official-auth plugins (image-search, zcode-site): skipped even with the helper                                          | M    |
| Done (#655): Desktop Context in the environment announcement (3.18 move)                                                | S    |

Accepted, not closed: the cold Activity boundary uses the admission time of a queued input
([fork-rust-activity-summary.md](fork-rust-activity-summary.md)), and the differences listed under "Known
differences kept on purpose" in [fork-rust-agent-parity.md](fork-rust-agent-parity.md).

The enc:v1 credential format is not a blocker: Rust reads and writes it (`platform` `credentials.rs`). Only the
read-time migration of older values is not ported.

## Order

1. Close the S items, then the M items, then memory.
2. Run the full desktop E2E gate on `ZCODE_E2E_AGENT_RUNTIME=rust` in the Linux box. A failure that also fails on Node
   is not a parity gap.
3. Flip the default runtime to `rust` and ship one fork release with Node still selectable.
4. Delete the Node agent runtime path, keeping the helper, storage preparation and the plugin cache seeder. Update
   AGENTS.md, the parity spec and the runtime selection spec in the same PR.

## Acceptance

- The E2E gate passes on Rust with no new skips.
- A fresh home on the Rust-only build has the official plugins, a migrated database and working helper families.
- No Host code path starts the Node agent.
