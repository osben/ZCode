# Per-workspace plugins and MCP for the shared local task runtime

Status: in progress (branch `fix/rust-workspace-plugins-mcp`). Design agreed with the user on
2026-11-14: per-workspace MCP isolation (not per session), lazy layer loading, fail-closed invalid
entries. Sibling of "Per-workspace hook snapshots" (#462, `specs/fork-rust-agent-parity.md`), which
solved the same problem for hooks; this spec does it for plugins and MCP.

## Background

Under shared task runtime routing (`sessionWorkspaceRouting`) the Desktop starts one zcode-rs agent
for all local workspaces, with the process cwd at `~/.zcode` (parity spec, "Per-workspace hook
snapshots"). Two process-wide owners then name the wrong workspace:

- `ExtConfig.workspace` (`ext/src/lib.rs:78`) is set once from the process cwd
  (`assemble/setup.rs:249-260` ← `process/facts.rs:57`). `Ext::start` loads the plugin set against it
  and `McpManager::start(workspace, servers)` keeps a single workspace for every stdio child
  (`ext/src/mcp/manager.rs:131`). A session's workspace never reaches either, so a project's
  plugin-enablement layer and its MCP servers are never loaded for that session.
- `HelperCatalog` (`protocol-zcode/src/fork/node_helper_sessions.rs:66`) intentionally names no
  workspace; per-session admission (`helper_session_admit.rs`) checks the process plugin catalog.
  Per-workspace admission stays out of this PR (spec `fork-rust-node-helper.md:312` names it the
  change after F3).

The candidate plugin roots themselves are already workspace-independent: user config dirs, the
official cache and `installed_plugins.json` all live under the storage root
(`cli/src/config/plugins.rs:149-188`, `platform/src/local/plugin_inventory.rs`).

## Node reference

- One app per session: `createRecord` → `createWorkspaceZCodeApp` → `createApp` with the session's
  `workspacePath` (`server-operations.ts:3975-4110`, `create-app.ts:205-209`).
- Plugin config is merged under the session's workingDirectory (`plugins.ts:1169-1194`
  `resolvePluginContext`): `plugins.enabledPlugins` / `suppressedBuiltins` from user **and project**
  layers; project configs strip `plugins.dirs` (`project-config.adapter.ts:129-132`).
- MCP: project layers keep `mcp.servers` with paths resolved against the project base dir
  (`project-config.adapter.ts:138-150`); user layers shadow project servers by name
  (`resolveEffectiveMcpServers`). The pool isolates connections by
  `mcpIsolation: "session"|"workspace"` with `workspaceKey = workspaceIdentity || workingDirectory`
  (`adapters/src/mcp/pool.ts:631,643`), and a stdio server's cwd resolves against the app's
  workingDirectory (`resolve(workingDirectory, cwd)`).

## Design (agreed 2026-11-14)

1. **MCP connections isolate per workspace, not per session.** One connection per server name per
   workspace key, shared by that workspace's sessions (Node's `workspaceKey`; keeps the shared
   runtime's child-process win over per-session apps).
2. **Lazy layer loading.** A workspace's layer is assembled at the session's first need, like
   `ProjectHookLoader` in #462; process startup stays as fast as today.
3. **Fail closed.** A project layer that cannot be read or parsed marks that workspace's entry
   `Invalid`: the session keeps the process-wide set only, until the next successful assembly.

## Owners

- **`SessionWorkspaces`** (new, `kernel-api`, mirroring `IncognitoProfiles`
  `kernel-api/src/incognito.rs:122`): the one in-memory owner of `session → workspace key`
  (`rust_cli_hooks::project_key(root)`, `hooks/src/projects.rs:49`). Written once by the protocol
  server when a `Live` session is created (it already holds the workspace, `live.rs`), read by the
  ext registry under the same lock discipline as incognito. The key follows the repo rule
  `workspaceIdentity?.trim() || workspacePath` where the session carries an identity (remote
  sessions), else `project_key(workspacePath)`.
- **`McpManager`** (changed): connection groups keyed by workspace key instead of one process-wide
  set. The process group (user-scope servers + the process plugin set's servers, cwd = the process
  workspace) stays for the non-shared single-workspace deployments; each shared-runtime workspace
  gets its own group holding that workspace's full server list: user servers with stdio cwd resolved
  against **that** workspace, the workspace's project servers (cwd = the declaring file's base dir),
  and the workspace plugin set's servers. Existing per-server semantics (machine bindings, disabled
  registry, reconnect budget, `McpView`) apply per group unchanged.
- **`WorkspacePluginLayer`** (new, `ext`): `BTreeMap<workspace key, Slot>` with
  `Slot = Loaded(layer) | Invalid`, one lock, epoch writes (`reserve`/`put_at`) exactly like
  `hooks/src/projects.rs:71-79,231-243`. The layer carries the per-workspace plugin admission
  (`Plugins` re-selected with the workspace's `enabledPlugins`/`suppressedBuiltins` view: same
  candidates, same manifests, no re-read on hit) plus that workspace's project MCP servers.
- **`WorkspaceLayerLoader`** (new trait + cli impl, mirroring `ProjectHookLoader` and
  `cli/src/config/project_hooks.rs:59-70`): discovers the workspace's project files
  (`config::files::discover(files, workspace)` — already workspace-parameterized), merges the plugin
  enablement view (project layers may set `enabledPlugins`/`suppressedBuiltins`, never `dirs`), and
  extracts project `mcp.servers` with per-file cwd resolution (`merge.rs::mcp_layers` +
  `resolve_project_cwds`).
- **`ExtRegistry::snapshot(session)` / `find_for(session, …)`** (changed): with a registered
  workspace the MCP part of the snapshot becomes the session's workspace group's view (union of the
  process tools and that group); without one (TUI, `-p`, session not yet registered) the process
  group answers, exactly as today. Incognito filtering composes on top of the group view.

## Event order

1. Process startup: `Ext::start` loads the process plugin set and starts the process MCP group —
   unchanged.
2. `session/create` (or resume) with `params.workspace`: the server registers
   `SessionWorkspaces[session] = key(workspaceIdentity?.trim() || workspacePath)`.
3. First snapshot/tool listing of that session: `WorkspacePluginLayer` misses → loader runs →
   `Loaded` (start the workspace's MCP group, no wait) or `Invalid` (process set only, one warn
   log). A hit serves from the map.
4. Model turn: the session's tool snapshot, `SessionCatalog` (`mcp_servers`), WaitForMcpServers and
   ToolSearch read the session's group (the same snapshot path they read today, parity spec
   "session keeps a snapshot of the tool profile"), so they follow without new owners.
5. Config change for a workspace (`/mcp enable|disable`, project config write): an epoch write
   replaces only that workspace's slot; connections of its group reconnect, other groups and the
   process group do not notice.

## Rules

- (a) A project layer never contributes plugin `dirs` (Node `project-config.adapter.ts`); a project
  layer's `enabledPlugins` overlays the user view by id, `suppressedBuiltins` replaces whole (the
  existing layer-merge semantics of `config/plugins.rs`).
  The same boundary holds for the inventory: a project's `storage.dir` never redirects the
  plugin cache or `installed_plugins.json` (trusted user/env/`--settings` layers only), in the
  workspace layer and the LSP plugin view alike.
- (b) Server names collide the Node way inside one group: user shadows project by name; disabled
  (user or project) shadows enabled. Across groups names are independent (two workspaces may run
  same-named servers, as Node's per-app pools do).
- (c) stdio cwd: project server → the declaring file's base dir; user/plugin server → the group's
  workspace root (Node `resolve(workingDirectory, cwd)`); `None` cwd keeps today's default. Machine
  bindings keep the raw cwd for non-primary machines.
- (d) `Invalid` lasts until the next successful assembly (a retry on the session's next start, or a
  config-change epoch write) — the same lifetime as hooks' invalid entries.
- (e) No timeout masks the lazy load: the first snapshot awaits the loader (bounded file reads), and
  a stuck loader surfaces as the session's MCP view pending, not as a hang.
- (f) The trap from the handoff holds: nothing derives a workspace from the process cwd or from
  `HelperCatalog`; only the session's `WorkspaceRef` (protocol `params.workspace`) does.

## Not in this PR (follow-ups)

- Per-workspace `HelperCatalog` admission and helper-hosted plugin servers per workspace
  (`fork-rust-node-helper.md:312`).
- The workspace plugin set's hooks (`hooks.register_plugins` stays process-wide until the engine's
  per-workspace entries can carry plugin sources; the slot already stores the loaded set). The
  workspace's skills and agent files gained their views in the follow-up PR: `SkillCatalog` reads a
  loaded slot's `skill_roots()` through the layer, and `AgentCatalog` resolves a workspace's files
  through a layer-backed lookup before the process set.
- MCP Apps on Rust-hosted servers (F7) and `helper/appTools/*` (F3b) — unchanged scope.
- The TUI (single workspace by construction) keeps the process group; no per-workspace TUI surface.
- `/mcp enable|disable|reconnect` stay process-group operations (TUI flows).
- ~~The LSP path's project `plugins.dirs`~~ — closed: `plugin_view` applies the Node rule (project
  dirs never load; the inventory roots resolve from the trusted layers only), and the workspace
  loader reuses the view instead of its own copy.

## Acceptance

- Acceptance: a project config declaring `plugins.dirs` or a `storage.dir` into a checked-in
  directory changes neither the workspace layer's nor `lsp/status`'s plugin set (the trusted-layer
  resolution of `plugin_view`).
- Rust unit tests (ext, cli, protocol-zcode):
  - a session with a registered workspace sees its project `mcp.servers` (name, cwd per base dir)
    and its `enabledPlugins` overlay; another workspace's servers and enablement are invisible to it;
  - user shadows project by name inside a group; two groups run the same name independently;
  - an unreadable/broken project layer → `Invalid`: the session keeps the process set, the next
    successful assembly recovers;
  - without a registered workspace (TUI/`-p`) the snapshot equals today's;
  - incognito + workspace filtering compose (a profile-hidden server never answers through any
    group).
- Existing suites: `cargo test`/`clippy` for `ext`, `cli`, `protocol-zcode`, `kernel-api`, `hooks`
  (key reuse), `env-local` (spawn cwd); `pnpm test:fork` for touched manifests.
- E2E (box, after CI-green): `plugins/*` family under a second workspace — project server connects
  with the project cwd and the project enablement applies (the family currently passes with the
  process-wide set only).
