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
3. Session open (create or resume) of that session: `WorkspacePluginLayer` misses → loader runs →
   `Loaded` (start the workspace's MCP group, no wait) or `Invalid` (process set only, one warn
   log). A hit re-reads too (Fork, PLM-LC-010, Node parity — "As built: session-open re-read"
   below): the loader runs again and the slot, group and hooks are replaced only when the fresh
   read differs; an equal read keeps the slot and its live connections. The settle lives at the
   turn's boundary, not the load's — a group's connections start without waiting and an
   unchanged slot a later session reuses never starts them again, so the turn's tool snapshot (query `step.rs`) runs
   `McpConnections::wait_for_first_connections` before it is taken (connected or failed, bounded
   by the connect wait; print sessions keep `wait_for_print`'s policy, deferred helper-hosted
   servers and later reconnects excluded) and takes the snapshot again when it waited — the
   desktop's first request (`toolSearchMode: "off"`) then advertises a freshly installed plugin's
   tools inline, like Node's first request does.
4. Model turn: the session's tool snapshot, `SessionCatalog` (`mcp_servers`), WaitForMcpServers and
   ToolSearch read the session's group (the same snapshot path they read today, parity spec
   "session keeps a snapshot of the tool profile"), so they follow without new owners.
5. Config change for a workspace (a hook trust write the App committed, `/mcp enable|disable`, a
   changed read at a session open): an epoch write replaces only that workspace's slot ("As built:
   layer reload" below). The new group serves the sessions that open after it; open sessions keep
   the group they started with ("As built: a session keeps its group"). Other groups and the process
   group do not notice.

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

## As built: plugin hooks per workspace

The hooks engine (`hooks/src/projects.rs`) carries per-workspace plugin sources beside the project
entries. When the layer installs a `Loaded` slot it hands the set's hooks to the engine for that
workspace key (a sink on `WorkspaceLayer`; the conversion reuses the hooks half of
`runtime/src/ext.rs::plugin_parts`), and a later install replaces them. A workspace with its own
sources runs them — combined with the process settings sources and its admitted project sources
exactly as before — instead of the process plugin hooks; every other entry, the process workspace
above all, keeps the process plugin hooks, and `register_plugins` (process) recombines only the
entries without their own sources. The sink runs before the layer's waiters wake, so a session that
opens on the new slot finds the hooks registered; the one lock and the epoch writes of the project
entries are unchanged (a plugin registration is one synchronous write, like the process one).

## As built: layer reload

The load-once guard is closed: `WorkspaceLayer::reload(workspace)` (wired through
`WorkspaceLayerHost::reload` and the kernel's `reload_workspace_layer`) re-runs the loader for one
workspace past the `Loaded`-reuse guard. Node's equivalent is each session app re-reading config at
construction; the Rust side keeps the explicit-trigger model — the App's config-write paths call the
reload after the write they committed, never a file watcher:

- `workspace/hooks/trustGrant` and the hook review's grant and revoke (`rebuild_hooks`, the same
  place that rebuilds the hooks entry) and the review toggle's committed write:
  `frontends/app_workspace.rs`. An accepted `workspace/mcp/trust` decision does not reload: Node's
  decision only refreshes the banners (`refreshWorkspaceTrustAdmission`, "does not connect, does not
  grant"), and the next session open reads the new record ("As built: session-open re-read"). Before,
  the reload restarted the workspace group, so an open task connected a server the moment it was
  trusted (WMT-01/04 failed at `expect(await exists(marker)).toBe(false)`).
- `/mcp enable|disable` (both TUI surfaces: the slash command and the settings page): the kernel's
  `mcp_control` names the calling surface's current workspace, and an enable/disable — which the
  TUI issues only after its `enabled` write committed — reloads that workspace's layer through the
  same path (`runtime/src/kernel.rs`). Reconnect writes no config and does not reload.

The mechanism mirrors the hooks engine's `reserve_project`/`put_project_at`: every slot carries the
epoch of the write that put it, a write reserves its epoch before it reads, and `put_at` refuses a
write whose epoch a later write already superseded — an in-flight session load that started before a
reload cannot install its older read over the newer slot, and (the group swap runs inside the same
acceptance check) it cannot replace the group either. A plain `load` reserves when it claims the
single-flight key, so a reload triggered while it runs always reserves after it; a reload does not
queue behind the claim (the epochs arbitrate). Reload stays lazy: a workspace with neither a slot nor
a load in flight does not load on reload — nothing in this process uses it yet, and the next session
open reads the post-write config directly. A reload whose read equals the installed one installs
nothing, like a session-open re-read. A reload whose read fails installs `Invalid` and stops
the group exactly like a first load (fail-closed, rule (d)); a later reload or session retry
recovers. The replaced slot needs no new owners: the skill roots, agent files and helper admission
read `plugins_of` (the slot) per call, and the MCP view resolves the group per snapshot, so both
follow a replaced slot.

## As built: session-open re-read

Trigger (PLM-LC-010, box rustlog 2026-11-17): the desktop installs and enables a plugin through the
Host, which writes the plugin files and restarts only the plugin-workspace agent process — the
session agent process gets no write it committed, so the explicit reload triggers above never fire.
Its `ZCodeProject` slot was loaded by an earlier session (before the install) and every later
session reused it: the new session's group had no `secret-verifier` server, and the model's
tool_use answered `No such tool available` although the plugin-workspace process had connected it.

Node re-reads the app config at every session app construction. The Rust layer now does the same
at every session open (`WorkspaceLayer::load`, called by the kernel's create/resume and the print
`--continue` prewarm): a `Loaded` slot no longer short-circuits the read. The re-read runs under the
same one-load-at-a-time claim and epoch as a first load (a concurrent open of the same workspace
waits for it and then reuses its result; a reload that reserved later still wins). The fresh read is
compared with the installed one (the group's full server list and the re-selected plugin set, both
`PartialEq`): equal → nothing is installed (no group restart, no hooks re-registration, the
reserved epoch is simply unused); different → the normal epoch install replaces slot, group and
hooks for that workspace only. The print `--continue` prewarm (`WorkspaceLayerHost::prewarm`)
reads ahead of the open that follows: that open joins the read while it is in flight, or reuses its
slot once afterwards (a prewarm mark the open consumes), so the prewarm still takes the read off the
open's path. A re-read that fails is fail-closed like a reload (`Invalid`, the
group stops). Sessions already open keep their group handle semantics unchanged: a replaced group
is what a reload does today. Cost: one config + plugin inventory read per session open, as in Node.

## As built: a session keeps its group

Node builds an MCP pool per session app at construction, and its trust gate keeps that admission:
"revocation and config changes take effect in a new or restarted session or on an explicit
reconnect; a banner refresh does not change existing authorization"
(`workspace-mcp-trust/CONTRACT.md`). The Desktop says the same in the pending popover.

Rust shares one group per workspace key, so a replaced group used to reach every open session of the
workspace. Now `WorkspaceMcp` pins a group to a session the first time the session resolves it
(`for_session`, the session's first snapshot after its open loaded the layer):

- The owner of the pins is `WorkspaceMcp` (`ext/src/mcp/workspaces.rs`): session id to the key and
  the group it resolved. A session with no workspace group (the process group) is not pinned.
- A replaced or stopped group (`start_with_plugins` over an existing key, `stop`) is retired: it
  shuts down at once when no session holds it, else it keeps running for the sessions that hold it.
- A session close (`SessionScoped::released`, through `WorkspaceLayer::session_closed`) drops the
  pin. A retired group shuts down when its last pin goes. The current group of a key never shuts down
  on a release.
- A reopened session pins whatever group is current then, like a restarted Node session.

Order of events:

```text
session A opens  -> layer load (group G1) -> A's first snapshot pins G1
trust grant      -> trust record written, banners refresh (no reload, G1 unchanged)
session B opens  -> re-read differs -> G2 installed, G1 retired but pinned by A -> B pins G2
A keeps G1 (no newly trusted server), B has it
A closes         -> pin dropped -> G1 has no pins -> G1 shuts down
```

Cost: while an old and a new group both have sessions, the workspace runs two sets of connections,
as Node runs one pool per session app. Subagents, and anything else that resolves by a session id
with no recorded workspace, keep the process group as before.

Acceptance: `ext` tests (a pinned session keeps its group across a replace and a stop, a release
shuts a retired group only after its last pin, never the current group); a layer test (an equal
reload installs nothing); the `cli` test that an accepted MCP trust decision reloads nothing; E2E
`plugins/conversation-session-workspace-mcp-trust` on Rust.

## As built: the `.agents/mcp.json` fallback joins sessions

Node reads `<wd>/.agents/mcp.json` (`mcpServers`) as the fallback of `<wd>/.zcode/config.json`
(`dynamic-mcp-config.ts`, `config-loader.ts`). Its servers are workspace servers, so they go through
the same trust gate as servers declared in the project file. Rust used to read the file only for the
trust review (`mcp_trust::discover`), so a granted fallback server was listed in Settings but never
joined a session.

Now `Inspection::merge_fallback` (`cli/src/config/mcp_trust.rs`) adds the fallback declarations
discovery found to the merged project layer, in both loaders: the process assembly
(`config::assemble`) and the workspace layer loader (`WorkspaceLayer`, `workspace_layer.rs`).

- The rules stay those of discovery: the fallback applies only when the project files name no valid
  server and none failed validation; a user server name shadows it; a broken entry claims its name
  without declaring it; a missing or unreadable file declares nothing.
- The merged servers carry project scope and the origin `<wd>/.agents/mcp.json`, the file that declares
  them (`McpOrigin.fallback`). The stdio `cwd` base is the working directory like Node's
  `normalizeProjectMcpServer`, not that file's directory. `/mcp enable|disable` and the Settings toggle
  write `enabled` under the file's top-level `mcpServers` (`fallback_mcp_enabled_text`). Node has no
  such verbs, so this is a fork extension.
- Fail closed: the merge runs before the trust filter. An ungranted or changed declaration is dropped
  there, an enabled one needs a grant for its digest, a disabled one is listed only when granted.
- The user fallback `~/.agents/mcp.json` is a different file with other rules: see "As built: the user
  `~/.agents/mcp.json` fallback".
- The session pin from "As built: a session keeps its group" is unchanged. The fallback file is read
  with the other layer inputs on each session open, the layer compares the result with the installed
  group, and an equal read installs nothing.

Acceptance: `cli` tests (the workspace layer and the process snapshot take a granted fallback server
and drop an ungranted one, the fallback is ignored when the project file declares servers); E2E
`plugins/conversation-session-workspace-mcp-trust` and
`plugins/conversation-session-plugin-mcp-skill-workspace-root` on Rust.

## As built: the user `~/.agents/mcp.json` fallback

Node registers `~/.agents/mcp.json` as the fallback of the user config path
(`dynamic-mcp-config.ts` `fallbackPaths`, read by `config-loader.ts`). Rust did not read it, so a
user with servers only in that file had none in a Rust session.

- Applies when the user config (`~/.zcode/cli/config.json`) declares no server: the file is missing or
  unreadable, `mcp.servers` is absent or empty, or every entry is invalid (a disabled entry counts as
  declared). `config/user_fallback.rs` decides it and reads the file from the user's home, not through
  the workspace file port.
- The file's `mcpServers` become a user layer merged after the project layers, so the servers are
  user scope (`McpScope::User`), need no workspace review or grant, and shadow a project server of
  the same name (a project fallback entry of that name is skipped, as Node's user layer wins).
  Incognito drops them with the other user servers.
- A stdio `cwd` is not resolved against the file: user servers keep it raw, as in Node.
- A file that is not a JSON object, or whose `mcpServers` is not an object, yields nothing and a
  warning; a broken entry is skipped alone.
- `/mcp enable|disable` on such a server writes `enabled` under the file's top-level `mcpServers`
  (`write_user_fallback_mcp_enabled`, the same lock as the config writer), not into `config.json`.
- Not changed: Node's trust discovery and `mcp/list` without a Host list read the config through
  `createConfig`, which never sees this file, so `mcp_trust` does not know it. The Desktop's own
  server list (the `mcpServers` of `mcp/list`) already carries what it resolved.
- The `.agents/mcp.json` name rule is already Node's: the system, env and cli layers carry no
  `mcp.servers` for trust discovery (`DefaultRuntimeConfig.mcp.servers` is empty, `parseEnvConfig` and
  `cliOverrides` give none), so only user names make a project fallback entry skip.

Acceptance: `cli` tests in `config/user_fallback_tests.rs` (when it applies, user scope without a
grant, shadowing, broken file, the toggle target in `frontends/tui_mcp_tests.rs`).

## As built: the settings lane revalidates in place

Node's `mcp/list` connect calls `connectConfiguredServers(servers, {revalidate: true})`: a server
with the same configuration keeps its record, a connected one is probed with `ping` (5 s, or the
server's own timeout when shorter; a JSON-RPC error answer still counts as alive), a failed one
reconnects, and only changed, removed and new servers are stopped or started. Rust closed the whole
lane and respawned every child on each connect.

- Owner: `AppWorkspace` (`app_workspace.rs`). A connect for the same workspace key keeps the lane's
  `McpManager` and calls `McpManager::reconcile` (`ext` `mcp/manager_reconcile.rs`) under the lane lock,
  so it stays ordered against newer connects; `Reconciled::settle` then closes the stopped clients and
  probes the kept connected ones outside the lock, restarting the dead. A connect for another key
  starts a manager of its own and closes the displaced lane, as before.
- `reconcile` restarts a changed or failed server in place (the generation moves on, so the old
  task's late updates are dropped), removes a name that is no longer wanted (cancel, close, app
  listeners run), and starts new names. A status read between install and settle shows a failed server
  that the lane is about to revive as `connecting`.
- The lane's connect timeout, tool timeout and output cap come from the process environment
  (`MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `MAX_MCP_OUTPUT_TOKENS`) through the same reader as a session's
  settings (`assemble::mcp::with_env_limits`). Node itself has no such variables: its adapter uses the
  server's `timeoutMs` or 30 s. The lane follows the Rust sessions here, so a Settings connect gives up
  when a session would.
- This lowers the lane churn recorded in `fork-rust-mcp-oauth.md` "E2E findings": a refresh no longer
  spawns a new stdio child for an unchanged server.

Acceptance: `ext` tests in `manager_reconcile_tests.rs` (unchanged keeps its connection, ping error is
alive, a silent server reconnects, changed/removed/new follow the set, a failed server is retried);
`cli` tests in `app_workspace_tests.rs` (same key shares the manager, another key closes the lane, the
timeouts); E2E `plugins/conversation-session-workspace-mcp-trust` on Rust.

## As built: retired CUA MCP servers

Node drops the historical standalone zcode-cua MCP server from every effective server set and from
the Settings rows (`isRetiredCuaMcpServer`, `bootstrap/src/mcp-config.ts`; matchers in
`packages/shared/src/mcp.ts`). Computer use runs through `node_repl`, which is never retired.

- Match (`ext` `mcp/retired.rs`): a stdio server whose name is not `node_repl` and either is named
  `computer-use`, has `ZCODE_PLUGIN_ID` (trimmed, lowercased) equal to
  `computer-use@zcode-plugins-official`, has a command that names the `zcode-cua` package, or has an
  argument that does. "Names the package": the value or its last path segment, with `_` read as `-`,
  is `zcode-cua`, or starts with `zcode-cua[`, `zcode-cua@`, `zcode-cua==` or `zcode-cua.`
  (case-sensitive; `zcode-cua-proxy` stays out). Other transports are never retired.
- Applied in `McpManager::start`, `register_disabled` and `reconcile` (every group: process,
  workspace layers, the settings lane), and in the settings lane's rows and plugin servers
  (`app_workspace.rs` `retired_row`). A `NodeHelper` plugin server has no command, so only the
  name rule can match it; the official computer-use plugin reaches Rust as `node_repl`.

Acceptance: `ext` tests in `retired_tests.rs` and `manager_reconcile_tests.rs`; `cli` test
`a_retired_cua_server_is_neither_listed_nor_connected`.

## As built: official plugin servers in `process/childProcesses`

Node registers a server of an official-marketplace plugin with `source.kind: "builtin"`
(`adapters/src/plugins/mcp.ts`), so `process/childProcesses` lists it as `builtin`. The Rust
connection table keeps only `(pid, server name)`, so the source is decided at answer time:
`McpProvenance` (`kernel-api`) is implemented by the extension registry over `WorkspaceMcp`, which asks
the process group and every workspace group for the plugin id of the server name
(`McpManager::note_plugin_ids`, filled when a group starts). A name is `builtin` when at least one group
(the process group, a workspace group, or a retired group a session still pins) knows it and every plugin id it finds ends in `@zcode-plugins-official`. A name that two groups
attribute to different marketplaces stays `plugin`, because the table is keyed by name and cannot tell
which group started the process. The plugin name still comes from the server name.

Acceptance: an `ext` test (official, third-party, mixed and unknown names across the process group and
two workspace groups); a `protocol-zcode` test (an official plugin's server is `builtin` with its plugin
name, a third-party one stays `plugin`).

## Not in this PR (follow-ups)

- ~~Per-workspace `HelperCatalog` admission and helper-hosted plugin servers per workspace~~ — closed:
  the admission half landed with the store-row resolution (`fork-rust-node-helper.md` F3, "Session
  open and close"), and the helper MCP pipes now connect per session workspace
  (`fork-rust-node-helper.md` F3, "The pipe workspace is enforced": a connection's own pipe keeps its
  manager group's workspace for listing, each further workspace key gets its own pipe for its
  sessions' calls, and the pipe-workspace refusal is on).
- ~~The workspace plugin set's hooks~~ — closed ("As built" above). The workspace's skills and agent
  files gained their views in the follow-up PR: `SkillCatalog` reads a loaded slot's `skill_roots()`
  through the layer, and `AgentCatalog` resolves a workspace's files through a layer-backed lookup
  before the process set.
- MCP Apps on Rust-hosted servers (F7) and `helper/appTools/*` (F3b) — unchanged scope.
- The TUI (single workspace by construction) keeps the process group; no per-workspace TUI surface.
- ~~`/mcp enable|disable|reconnect` stay process-group operations (TUI flows). Wiring them into the
  layer reload~~ — closed: `McpControl` carries the calling surface's current workspace, and the
  kernel's `mcp_control` reloads it after an enable/disable (the TUI persists `enabled` before the
  control, so the reload reads the committed file; the process manager still restarts only the
  servers it owns, and reconnect reloads nothing). The TUI's slash surface and settings page both
  pass the session's current workspace. Deliberate divergence from Node, recorded: Node's `/mcp`
  has no enable/disable verbs at all (`handlers/mcp.ts` usage line) — the Rust verbs are a fork
  extension, and the layer reload is the shared-runtime equivalent of Node's per-app config
  re-read at every session app construction, not a Node behavior copy. The reload is unconditional
  for enable/disable (the App's trust triggers are too): a toggled user-scope server still reaches
  workspace groups only with its startup-snapshot state, because the layer's user-scope server
  list is a process-startup read.
- ~~The LSP path's project `plugins.dirs`~~ — closed: `plugin_view` applies the Node rule (a project
  dir loads only with a workspace plugin trust record for its current declaration,
  `fork-rust-plugin-workspace-trust.md` part 2; the inventory roots resolve from the trusted layers only),
  and the workspace loader reuses the view instead of its own copy.

## Acceptance

- Acceptance: a project config declaring an untrusted `plugins.dirs` or a `storage.dir` into a checked-in
  directory changes neither the workspace layer's nor `lsp/status`'s plugin set (the trusted-layer
  resolution of `plugin_view`).
- Rust unit tests (ext, cli, protocol-zcode):
  - a session with a registered workspace sees its project `mcp.servers` (name, cwd per base dir)
    and its `enabledPlugins` overlay; another workspace's servers and enablement are invisible to it;
  - a workspace whose layer loaded its own plugin set runs that set's hooks, not the process plugin
    hooks (hooks, ext); the process workspace and workspaces without a loaded set keep the process
    hooks;
  - user shadows project by name inside a group; two groups run the same name independently;
  - an unreadable/broken project layer → `Invalid`: the session keeps the process set, the next
    successful assembly recovers;
  - a session open of a workspace whose loaded slot is stale (a plugin installed by another
    process since) re-reads and installs the new set and group; an unchanged re-read keeps the
    slot, the group (no restart) and the hooks registration; a concurrent open waits for the
    in-flight re-read (ext);
  - a reload after a committed write replaces the slot, the group and the plugin-hook registration
    for that workspace only; an in-flight load that started earlier never installs over it; a reload
    of a never-loaded workspace loads nothing; the App's trust paths (`workspace/hooks/trustGrant`,
    review grant/revoke/toggle, an accepted `workspace/mcp/trust`) and `/mcp enable|disable`
    (enable/disable reload the control's workspace; reconnect does not) trigger the reload (cli,
    runtime);
  - without a registered workspace (TUI/`-p`) the snapshot equals today's;
  - incognito + workspace filtering compose (a profile-hidden server never answers through any
    group).
- Existing suites: `cargo test`/`clippy` for `ext`, `cli`, `protocol-zcode`, `kernel-api`, `hooks`
  (key reuse), `env-local` (spawn cwd); `pnpm test:fork` for touched manifests.
- E2E (box, after CI-green): `plugins/*` family under a second workspace — project server connects
  with the project cwd and the project enablement applies (the family currently passes with the
  process-wide set only).
