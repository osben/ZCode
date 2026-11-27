# Plugin workspace trust on zcode-rs (`plugins/workspaceTrust`)

Status: implemented in zcode-rs (2026-11-26).

## Background

The 4.0 upstream sync added `plugins/workspaceTrust` (`packages/shared/src/zcode-protocol/index.ts:4722`,
`pluginsWorkspaceTrust`). The settings page "Project" view lists the plugins that a project's
`plugins.dirs` declares. An untrusted one shows "pending" with a Trust button, and the button calls
`IPluginManagementService.setWorkspacePluginTrust` (`packages/services/src/zcode-agent/zcodeAgentService.ts:6291`),
which sends `plugins/workspaceTrust` to the agent. zcode-rs neither handled nor forwarded the method, so the
App got -32601 and the prompt did not work. Product rules of the feature itself:
`docs/plugins/workspace-plugin-dir-trust.md`.

## Node reference

- Handler: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts:299` `setPluginWorkspaceTrust`,
  dispatched at `zcode-protocol/server.ts:958`. It parses `zcodePluginsWorkspaceTrustParamsSchema`
  (`{workspace, pluginRoot, declarationDigest, trusted}`) and calls `setWorkspacePluginTrust`
  (`bootstrap/src/workspace-plugin-trust/index.ts:105`). Result `{accepted, reasonCode?}` with
  `workspace_plugin_declaration_changed` or `workspace_plugin_trust_unavailable`.
- The write is under a file lock on `<storage root>/security/workspace-plugin-trust-v1.json`. A trust request re-reads
  the project config and the plugin declaration and refuses a digest that no longer matches. A revoke needs no digest.
- Plugin discovery reads the same record (`resolveWorkspacePluginDiscovery`, `workspace-plugin-trust/index.ts:79`)
  and `trustOf` (`adapters/src/plugins/workspace-plugin-declaration/index.ts:135`) sets `workspaceTrust` on each
  project directory plugin of `plugins/list` and `plugins/overview` (`bootstrap/.../plugins.ts:129`).
  A pending plugin is forced disabled (`adapters/src/plugins/index.ts:247`).
- Node does not invalidate the plugin caches after a trust write (`PLUGIN_PREPARATION_MUTATION_METHODS`,
  `zcode-protocol/server-types.ts:264`, has no trust entry). The App reloads the list itself
  (`pluginManagementStore.ts:445`, `fresh: true`).

## Decision: forward to the Node helper

Rust already forwards the whole `plugins/*` management family to the Node helper (`fork-rust-node-helper.md`, F1).
`plugins/list` and `plugins/overview` run in the helper, so the helper is the process that computes `workspaceTrust`.
The trust record, the declaration digest and the project config re-read live in Node code that Rust does not have
(`inspectWorkspacePluginRoot`, `createConfig`, the file lock). A Rust handler would duplicate that digest and the
record format, and a digest mismatch between the two sides would silently refuse every trust. So the method belongs
in the forward list, not in a Rust handler.

## Product rules

1. `plugins/workspaceTrust` is in Rust's forwarded method list, and the helper advertises it in `helper/initialize`
   `methods` and serves it with the same handler Node's server uses (`setPluginWorkspaceTrust`).
2. Params and result pass through unchanged, including both `reasonCode` values. Rust adds no field and does not
   interpret the result.
3. The call uses the plugin-management timeout (300 s), like every `plugins/*` call.
4. The helper does not invalidate its plugin caches after this method (same as Node).
5. A Host with no helper configured, or a helper that does not advertise the method, answers the existing
   helper-unavailable error (`proto.forkRustAgent.nodeHelperUnavailable`), as for the other forwarded methods.

## State owner

The trust record file is owned by the helper's Node code (one writer, under its file lock), exactly as in Node.
Rust holds no trust state for plugins.

## Interface

- `packages/rust-cli/crates/protocol-zcode/src/fork/node_helper.rs`: `FORWARDED_METHODS` gains `plugins/workspaceTrust`
  (21 -> 22 `plugins/*` entries, 57 -> 58 in all).
- `apps/zcode-cli/packages/bootstrap/src/fork-rust-helper/methods.ts` and `server.ts`: the helper's method list and
  handler table gain `zcodeProtocolMethods.pluginsWorkspaceTrust` -> `setPluginWorkspaceTrust(context, params)`.

## Acceptance cases

- Rust: `forwarded_table_is_the_spec_list` counts the method; `each_forwarded_method_uses_the_hosts_timeout_for_it`
  gives it 300 s; a forwarded call reaches the helper with the params untouched and returns its result.
- Helper (vitest): `plugins/workspaceTrust` is in the advertised methods. A project directory plugin lists as
  `pending`, a trust call with its digest answers `{accepted: true}`, and the next `plugins/list` shows `trusted`.
  A stale digest answers `workspace_plugin_declaration_changed`.

## Part 2: loading trusted project directory plugins

Before: a zcode-rs agent never loaded a project `plugins.dirs` plugin, trusted or not
(`cli/src/config/mod.rs` `plugin_view_of` kept only the user and `--settings` dirs). After a trust write the settings
page showed `trusted`, but a new Rust session had none of the plugin's hooks, MCP servers, skills or commands
(WPL-014 failed at `assertWorkspacePluginRuntime`). Worse, the process assembly (`config::assemble`, the TUI and `-p`)
merged every layer, so there a project `plugins.dirs` loaded without any trust.

### Node reference

- Candidates: each loaded project file's `plugins.dirs`, a relative dir resolved against that file's base dir
  (`getProjectConfigBaseDir`: the parent of `.zcode`, else the file's dir), an absolute one resolved as is
  (`project-config.adapter.ts:63-66`), deduped (`config-factory.ts:437`).
- Order (`adapters/src/plugins/index.ts` `resolveCandidates`): user dirs, then project candidates, then official,
  then installed. A project root that is also a user dir loads as the user source (`candidatesOf`).
- Admission: `trustOf` computes the declaration digest and the candidate is `trusted` only when a record of this
  workspace identity has the same `pluginRoot` and `declarationDigest`. A pending one is forced disabled.
- Records: `<dir of the hook trust store>/workspace-plugin-trust-v1.json`, `{schemaVersion: 1, records:
[{workspaceIdentity, pluginRoot, declarationDigest, grantedAt}]}`, strict. Unreadable or invalid: nothing trusted.
- Digest (`computeWorkspacePluginDeclarationDigest`): sha256 hex of
  `JSON.stringify({version: 1, pluginRoot, files})`, where `files` are, deduped by absolute path:
  the first manifest found among `.zcode-plugin/plugin.json`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`; `hooks/hooks.json`; `.mcp.json`; every string in the manifest's `hooks` and
  `mcpServers` (nested arrays walked), dropping absolute paths and paths outside the root. Each entry is
  `{path, text}`: `path` relative to the plugin root with `/`, `text` the file with CRLF turned into LF, or `null`
  when it is missing. Entries are sorted by `path` in code unit order. `pluginRoot` is the root relative to the
  workspace root with `/`, `.` for the root itself. A first manifest that is not a JSON object with a valid name
  makes the plugin unavailable (no fallback to the next one).

### Rules

6. Owner: the config assembly (`cli/src/config/workspace_plugins.rs`). It reads the project candidates from the
   project files it already read, the record file from disk, and the plugin declaration files from local disk (plugin
   dirs are on the controller, like the user dirs). Rust writes no record; the helper stays the only writer.
7. Identity: the workspace root, the same key Rust's hook and MCP trust use for a session
   (`mcp_trust::Target::new(root, None)`).
8. A candidate loads only when a record with this identity, its `pluginRoot` and its current digest exists. A pending
   candidate is left out of the plugin sources (Node lists it disabled; Rust's plugin list comes from the helper, so
   the session view needs only the loadable set).
9. A trusted candidate is an inline config-dir candidate (`PluginOrigin::ConfigDir`, marketplace `inline`), placed
   right after the user dirs, so `enabledPlugins` and name collisions work as in Node. A root that a user or
   `--settings` dir already lists is not added again.
10. Both config paths use this: the workspace layer (`plugin_view_of`, re-read at every session open, so a new
    session after a trust write gets the plugin) and the process assembly (`assemble`), which no longer takes
    `plugins.dirs` from project layers.
11. The digest is byte compatible with Node: a fixed field order (`version`, `pluginRoot`, `files`, and `path`, `text`
    in each entry), serde_json string escaping (same as `JSON.stringify` for valid UTF-8), files read as lossy UTF-8
    like Node's `readFile(..., "utf8")`.

```text
helper (Node): plugins/workspaceTrust -> writes workspace-plugin-trust-v1.json (file lock)
session open (Rust): read project files -> candidates -> digest each -> match records -> plugin sources
```

### Acceptance (part 2)

- A Node golden (`cli/src/config/workspace_plugins_golden.json`, generated by
  `scripts/fork-rust-workspace-plugin-digest-golden.ts` from `inspectWorkspacePluginRoot`) gives the same hex in
  Rust for: a manifest only, manifest plus hooks plus `.mcp.json`, nested `mcpServers` arrays with an absolute and an
  escaping path, a CRLF file, a `.claude-plugin` manifest, a plugin at the workspace root (`.`) and a nested one.
- With a matching record a new workspace layer load and the process assembly list the plugin dir; with no record, a
  stale digest, another identity or a corrupt store they do not. A project dir that is also a user dir appears once.
- WPL-014 passes on Rust in the box.

## Known differences

- Managed worktrees map to their source repository as in Node: see
  [fork-rust-managed-worktree-trust-identity.md](fork-rust-managed-worktree-trust-identity.md). Remote workspaces have no Rust project plugin loading at all (the project files are read on the controller).
