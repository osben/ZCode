# Plugin workspace trust on zcode-rs (`plugins/workspaceTrust`)

Status: in progress (branch `fix/rust-plugin-trust-workspace-config`).

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

## Known differences

- A zcode-rs agent never loads a project `plugins.dirs` plugin, trusted or not: Rust strips project `plugins.dirs`
  from the layers it executes (`cli/src/config/mod.rs:271`, `fork-rust-workspace-plugins-mcp.md`). So after a trust
  write the plugin is listed as `trusted` by the helper, but a Rust session does not get its hooks, MCP servers,
  skills or commands. Loading trusted project directory plugins in Rust needs the digest and the trust record in
  Rust and is not part of this change. The settings page therefore shows the right state, and the "new sessions
  pick it up" hint is not true on a zcode-rs agent yet.
