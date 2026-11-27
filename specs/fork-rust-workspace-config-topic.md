# The `workspace-config/<workspaceId>` topic on zcode-rs

Status: in progress (branch `fix/rust-plugin-trust-workspace-config`).

## Background

`protocol-zcode/src/index.rs` answered every `workspace-config/<workspaceId>` snapshot with
`{"configOptions": [], "slashCommands": []}`. Node puts a mode option and the slash-command catalog there while a
session of that workspace is open. The Desktop's workspace-config consumer (`subscribeWorkspaceConfigV4`,
`packages/services/src/zcode-agent/zcodeAgentService.ts:8171`) forwards the state as
`workspace_config_options_update`, so a Rust agent showed no mode choice and no slash commands from this topic.

## Node reference

- Schema: `packages/shared/src/zcode-protocol-v4/workspace-config.ts`. The state is
  `{configOptions: WorkspaceConfigOption[], slashCommands: WorkspaceSlashCommand[]}`. The snapshot is
  `{protocolVersion: 1, workspaceId, logEpoch, config}`. The only delta is `{op: "config.updated", config}`, a whole
  replacement (conflated latest state, "never deep-merge").
- Content: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-workspace-config.ts`.
  - `toV4WorkspaceConfigState` (line 11): exactly one option, `{id: "mode", name: "Mode", category: "mode",
type: "select", currentValue: normalizeAvailableZCodeMode(settings.mode.current),
options: getZCodeAgentModeSelectOptions()}`. No model option: model candidates come from the Host's
    ModelSelectionView (comment at line 1).
  - The four mode options (`packages/shared/src/zcode-agent-model-state.ts:21`): `build` "Ask before changes",
    `guarded` "Autonomous mode", `plan` "Plan mode", `yolo` "Full access", each with its description.
    `normalizeAvailableZCodeMode` keeps `build|guarded|plan|yolo|edit` and maps any other value (`auto`) to `build`.
  - Slash commands: `listProtocolSlashCommands` (`zcode-protocol/slash-commands.ts:21`), the same catalog as the
    `slashCommands` of `workspace/readPresentation`: the visible built-ins (`workflow` only while the gate is open),
    then the custom commands that are interactive and not reserved, as `{name, description, inputHint, source}`.
  - Source of the state, `buildLiveWorkspaceConfigStateV4` (line 44): the first registered session whose
    `workspace.workspaceKey` equals the topic's workspace id. Its settings give the mode, its `workspacePath` is the
    cwd the custom commands are discovered under. With no such session the builder returns `null` and the topic
    carries the empty state (the comment at line 36 explains why: no temporary app at host warmup).
- Publisher: `zcode-protocol-v4/workspace-config-publisher.ts` and `v4-gateway.ts:1620-1700`. The seed is pulled once,
  when the first subscriber creates the publisher (`ensureConfigPublisher`); later subscribers get that cached state.
  `publishWorkspaceConfig` (the only path that produces a `config.updated` delta) has no caller in
  `apps/zcode-cli/packages/bootstrap`, nor in the Host: a search for `publishWorkspaceConfig` finds only its own
  definition. So Node emits no delta today.

## Product rules

1. The snapshot of `workspace-config/<workspaceId>` carries `config` built as in Node: with at least one open session
   in that workspace, `configOptions` is the single mode option and `slashCommands` the presentation catalog; with
   none, both are empty arrays.
2. The workspace id matches the sessions-index key (`Live` listed workspace), as Node matches `workspaceKey`.
3. The mode option's `currentValue` is the mode of an open session of the workspace, normalized: `build`, `guarded`,
   `plan`, `yolo` and `edit` stay, anything else (`auto`) is `build`. Several open sessions: the one with the
   smallest session id (stable, since Rust's session table has no insertion order).
4. The mode options are the four fixed entries above, in that order, with Node's names and descriptions.
5. The slash commands are the same list `workspace/readPresentation` answers (one builder, `fork/slash_builtins.rs`),
   discovered under the chosen session's cwd (its execution worktree when it has one), as Node uses
   `record.workspace.workspacePath`.
6. The state is read on every snapshot: the first frame of a subscribe and of a resync. No delta is emitted (Node
   emits none).

## State owner

The state is derived, not stored: the open sessions (`SessionBridge`) own the mode, the kernel's command catalog owns
the commands. `Topics` only carries the value it is handed for the snapshot. No new storage, no `setting.json` key.

## Interface

- `protocol-zcode/src/fork/workspace_config.rs`: `empty()` and `state(mode, commands)` build the value (pure).
- `Server::workspace_config(workspace)` picks the session and reads the commands; `subscribe.rs` passes the value to
  `Topics::start` as the one `stored` row of a config topic, for subscribe and resync.
- `Topics::snapshot` uses that row as `config` and falls back to the empty state when it is absent.
- `Live::listed_workspace()` exposes the listed workspace key.

## Acceptance cases

- `state("build", ...)` has one option `mode` with the four options and `currentValue: "build"`; `auto` and an unknown
  value give `build`; `edit`, `plan`, `guarded`, `yolo` stay.
- A config snapshot made with a state row carries it; made without one it carries the empty state.
- With an open session `s1` in `/w`: the state of `/w` has the mode option and the built-in commands; the state of
  `/other` is empty.

## Known differences

- Node caches the first seed for the life of the process, so a subscriber that arrives after a session opened still
  sees the empty state if the first subscriber came earlier. Rust reads the state on each snapshot, so a late
  subscribe or a resync sees the live state. Nothing in Node publishes a later update either, so a started
  subscription stays on its first frame in both.
- Node picks the oldest registered session of the workspace; Rust picks the smallest session id.
- A resume with a `base` is answered with a snapshot (the existing topic behavior), where Node resumes from its log.
