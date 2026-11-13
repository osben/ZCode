# Fork: language servers in the Rust agent

Status: stage 1 (this spec's "Protocol surface") is implemented. Stage 2 ("Runtime") is the next PR in the same series.

Node references: bootstrap `zcode-protocol/lsp.ts`, `app/lsp-preferences.ts`, `app/lsp-runtime-hub.ts`, `zcode-protocol-entrypoint.ts` (the LSP hub); adapters `plugins/lsp.ts`, `plugins/template.ts`, `lsp/command-resolution.ts`; contracts `lsp/index.ts`; design `apps/zcode-cli/docs/design/v2/tool/19-lsp.md`.

## Product rules

- The plugin page's language-server section lists the servers that the enabled plugins declare for the workspace it shows. For each server it shows its state, its extensions, and a diagnostics-after-edit toggle. A global switch turns language servers off.
- The switch and the toggles are user preferences. Both runtimes keep them in one sidecar, `<cliStorageRoot>/fork_lsp_preferences.json`. A change made under one runtime is what the other one reads. They are never stored in `setting.json` (AGENTS.md).
- Stage 1 starts no server. A declared server is `not_installed` when its command cannot be found, and `stopped` otherwise. Stage 2 adds the running states (`starting`, `ready`, `crashed`, `unavailable`), the `LSP` agent tool, document sync and diagnostics after edits.

## Protocol surface (stage 1)

The methods are `lsp/preferences/get`, `lsp/preferences/set` and `lsp/status`.

- **Params.** Each call is checked first against the strict App schema (`zcodeLsp*ParamsSchema`, generated into `inbound.json`). A failure answers `-32602`. This is the same order as Node, where `parseParams` runs before the host check.
- **Host failure.** An error from the host (for example a sidecar that cannot be read on `set`) answers `-32603` with the error's message, as Node maps a thrown error.
- **No host.** A Rust process without the LSP host answers `-32000` "Language server support is not available in this runtime", as Node does when `context.lsp` is absent. Only the TUI and `-p` have no host, and they serve no protocol, so in practice the app-server always has one.
- **`lsp/preferences/get`** re-reads the sidecar and answers `{enabled, diagnosticsAfterEdit}`, which is the stored record without `version`.
- **`lsp/preferences/set`** merges `patch` onto the file as it is on disk and writes it. Then it applies the result to the runtime, which stage 1 does not have, so this step does nothing yet. It answers the new record.
- **`lsp/status`**:
  - It re-reads the sidecar.
  - It resolves the servers for `workspace.workspacePath` from scratch, as described in "Declarations". The path is normalized first (Node `resolve(workingDirectory)`), so `/w/` and `/w` give the same answer.
  - It answers `{enabled, servers}`, keeping the servers in declaration order. Each entry has:
    - `serverId`, `pluginId`, `serverName`, `command`;
    - `extensions`: the keys of the conflict-resolved `extensionToLanguage`, in declaration order;
    - `installed`;
    - `state`: `installed ? "stopped" : "not_installed"`;
    - `diagnosticsMode: "unknown"` (the protocol allows `pull`, `versioned`, `attributed` or `unknown`; stage 2 reports the real mode of a running server);
    - `diagnosticsAfterEdit`: `prefs[id] ?? config.diagnostics ?? true`;
    - `restarts: 0`;
    - no `lastErrorCode`.

## Owners

| Fact                            | Owner                                                                                                                 | Notes                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preferences sidecar             | cli `lsp::PreferencesStore`, one per Rust process (app-server assembly)                                               | Node's `LspPreferencesStore` owns the same file in a Node process. Neither runtime caches the file across calls: get and status re-read it, and set re-reads it before merging.                                                                                      |
| Declared servers of a workspace | `ext::plugins::lsp` (`declared`, `resolve`, `resolve_conflicts`), called for each status request                      | Pure functions over the loaded plugins; files are read through the local `Files` port. They never start anything.                                                                                                                                                    |
| Plugin set of a workspace       | cli `config::plugin_view` for the requested workspace, then `ext::plugins::load_all`                                  | The same config layers (user, project, local) and plugin admission as the session runtime's catalogs, without the hook, trust and MCP work of a full `config::assemble`. It is computed for each request, as Node does in `resolveZCodePlugins({workingDirectory})`. |
| Install probe                   | cli `lsp::installed`                                                                                                  | Same lookup as Node's `isLspCommandInstalled`. No cache.                                                                                                                                                                                                             |
| Status assembly                 | cli `lsp::Host`, the `LanguageServers` implementation                                                                 | It composes the four rows above.                                                                                                                                                                                                                                     |
| Protocol answer                 | `protocol-zcode` `fork/lsp.rs` through the kernel-api `lsp::LanguageServers` port, set once on the protocol `Context` | The protocol layer holds no LSP state.                                                                                                                                                                                                                               |

Event order for `lsp/preferences/set`:

```
App ── lsp/preferences/set ──▶ protocol (Inbound::method: strict params)
                                   │
                                   ▼
                         LanguageServers::set_preferences
                                   │  lock (one update at a time in this process)
                                   │  read sidecar ── not found → defaults
                                   │                ── invalid JSON or schema → defaults (then overwritten)
                                   │                ── other I/O error → the call fails, file untouched
                                   │  merge patch (null deletes an override)
                                   │  write temp file in the same directory, rename over the sidecar
                                   │  unlock
                                   │  apply to the runtime (stage 1: nothing; stage 2: stop all servers when disabled)
                                   ▼
App ◀── {enabled, diagnosticsAfterEdit}
```

Cross-runtime: the desktop runs one agent runtime at a time, but a Node agent and a Rust agent may still both be alive (another window, or the CLI). Both runtimes write through a same-directory rename, so a reader always sees one whole file. Each update merges onto what is on disk, so an earlier write from the other runtime is kept. Two concurrent writes from different processes are last-writer-wins, which is the same as two Node processes today.

## Preferences file

- **Path.** `getCliStorageRoot(resolve(storage.dir))`: the resolved `storage.dir` itself when its base name is `cli`, otherwise `<storage.dir>/cli`. `storage.dir` is read once, from the config the process started with (including the startup workspace's project layers) and `ZCODE_STORAGE_DIR`, with a default of `~/.zcode`. A relative value resolves against the startup workspace root, as Node's `resolvePath` resolves it against the process cwd. The path is fixed for the life of the process: a `status` call for another workspace does not move it. Rust computes it with `StoragePaths::lsp_preferences`, the same `cli` rule its other stores use.
- **Shape.** `{"version": 1, "enabled": bool, "diagnosticsAfterEdit": {serverId: bool}}`, strict. `version` must be the literal `1` and an unknown key fails the record. The defaults are `{1, true, {}}`.
- **Order.** A read waits behind a running update in the same process, as Node's `load` runs on the update queue.
- **Text.** `JSON.stringify(record, null, 2) + "\n": two-space indent, keys in the order `version`, `enabled`, `diagnosticsAfterEdit`, and override keys in JS property order: array-index keys (such as `"7"`) first in numeric order, then the rest in insertion order. A new override goes last; an existing one keeps its place. Rust writes this text by hand because `serde_json` does not know JS key order.

## Declarations

This is a port of adapters `plugins/lsp.ts` and `plugins/template.ts`.

- **Which plugins.** Only enabled plugins, in admission order, which is Node's candidate and priority order. A plugin Rust does not admit contributes no server. Rust skips:
  - official plugins that need the Node host (`NodeRuntime`);
  - a second plugin with an already-loaded name (`DuplicateName`).

  Node keeps both kinds. No official plugin of either kind declares a language server today. An official plugin with no
  skill, MCP server, agent or hook (such as `typescript-lsp`) claims no name, so it does not push out an installed
  plugin of the same name; both load, as in Node.

- **Default-enabled official plugins.** Node enables `typescript-lsp` and `zcode-site` without config. Rust's default list gains `typescript-lsp` here. That plugin has only a language server (no skills, commands, MCP servers or hooks), so the only visible effect is its status entry. `zcode-site` stays a follow-up.
- **Plugin id.** `<manifest name>@<marketplace>`, the same as Node. `--plugin-dir` plugins exist only in Rust and get `<name>@inline`. The server id is `<pluginId>/<serverName>`.
- **Sources.**
  - An optional `.lsp.json` at the plugin root.
  - The manifest `lspServers` field, which can be:
    - a path inside the plugin root (a path that escapes the root is an error; a declared file that is missing is a warning);
    - an array, merged left to right;
    - an inline map.
  - A file or map may use the `{"lspServers": {…}}` wrapper. Without it, the whole object is the map.
  - The merge is `{...fromFile, ...fromManifest}`, applied before validation. A redeclared name keeps its first position.
- **Validation** follows the strict `LspServerConfigSchema`:
  - `command` is a non-empty string;
  - `extensionToLanguage` is non-empty, with keys matching `^\.[^\s/\\]+$` and non-empty values;
  - `args` is an array of strings;
  - `transport` is `stdio` or `socket`;
  - `env` is a record of strings;
  - `initializationOptions` and `settings` can be anything;
  - `workspaceFolder` is a non-empty string;
  - the three timeouts are positive integers;
  - `restartOnCrash` is a bool;
  - `maxRestarts` is an integer ≥ 0;
  - `diagnostics` is a bool;
  - unknown keys are rejected.

  An invalid server is skipped with a warning log; the plugin's other servers stay.

- **Templates.** `${…}` is expanded in `command`, `args` and `workspaceFolder`, which are not sensitive, and in `env`, which is sensitive.
  - `CLAUDE_/ZCODE_PLUGIN_ROOT` is the plugin root.
  - `CLAUDE_/ZCODE_PLUGIN_DATA` is `<plugin storage>/data/<id with [^a-zA-Z0-9_.@-] → ->`.
  - `CLAUDE_/ZCODE_PROJECT_DIR` is the requested workspace path.
  - The session and skill variables are errors.
  - `user_config.<k>` comes from the merged config `plugins.options[id][k]`, else from the manifest `userConfig[k].default`. A missing value is an error, and so is a `sensitive` option outside `env`. Values are written the way JS `String(v)` writes them. Stage 1 does not read the sensitive values Node keeps in `<cliStorageRoot>/plugin-secrets.json`; a server whose template needs one is skipped with a warning. Stage 2 reads that file, since a running server needs those values in its `env`.
  - `ZCODE_*` names come from the process environment; a missing one is an error.
  - Any other name is taken from the environment only in `env`. Outside `env` it is left as written.

  An error skips that server only.

- **Defaults.** `env` is the six plugin identity variables, with the server's own `env` on top. `workspaceFolder` must stay inside the workspace and is stored relative to it; an empty result means the workspace root. The timeouts default to 30 000, 5 000 and 60 000 ms. `restartOnCrash` defaults to true, `maxRestarts` to 3 and `diagnostics` to true.
- **Extension conflicts.** Servers are walked in admission order. The first server to claim an extension keeps it. A later server keeps its other extensions and is dropped when it has none left. The output stays in the original order.

## Install probe

- **Env.** The process environment with the server's resolved `env` on top. On Windows, keys are compared case-insensitively.
- **Command with a directory part**, meaning it contains `/` or `\`, or is absolute: the command itself, resolved against the agent process's current directory, not the workspace.
- **Bare name:** each non-empty `PATH` entry joined with the name.
- **Windows:** `PATHEXT` candidates are tried as well (default `.COM;.EXE;.BAT;.CMD`), and quoted `PATH` entries are unquoted.
- **Test:** the candidate must be a regular file. Outside Windows it must also be executable.

## Differences kept on purpose

- Node's MCP stdio env puts the running Node binary's directory in front of `PATH` when the agent itself is a `node` process. The Rust agent is not, so it adds nothing.
- Node creates each enabled plugin's data directory while resolving. Rust's status call writes nothing except the sidecar on `set`.
- Rust has no plugin diagnostics list. Skipped servers and plugins are logged (`warn`) instead.

## Acceptance

1. `lsp/preferences/get` with no sidecar answers `{enabled: true, diagnosticsAfterEdit: {}}` and creates no file.
2. A Node-written sidecar is read back unchanged. A Rust-written sidecar parses under Node's `LspPreferencesSchema` and matches Node's text byte for byte. Both runtimes check this against one golden file, `packages/rust-cli/crates/cli/src/lsp/fixtures/fork_lsp_preferences.json`: the Rust test `the_patch_sequence_writes_the_golden_sidecar` and the fork Vitest `lsp-preferences-sidecar.test.ts` apply the same three patches (including a removal, a key that needs escaping and a non-ASCII key) and compare the bytes.
3. `set` with `{diagnosticsAfterEdit: {"a/x": false}}` and then `{enabled: false, diagnosticsAfterEdit: {"a/x": null, "b/y": true}}` leaves `{1, false, {"b/y": true}}`. A file edited between the two calls keeps the edited keys.
4. An invalid sidecar (bad JSON, `version: 2`, or an extra key) reads as the defaults. `set` replaces it. A sidecar that cannot be read, because it is a directory, fails `set` and stays as it was.
5. `lsp/status` for a workspace whose only LSP plugin is the official `typescript-lsp` lists `typescript-lsp@zcode-plugins-official/typescript` with its eight extensions in declaration order. The state is `stopped` when `typescript-language-server` is on `PATH` and `not_installed` otherwise.
6. A workspace that disables a plugin in its own config omits that plugin's servers, while another workspace served by the same process still lists them.
7. Declarations: the file plus manifest merge, the wrapper, array and path forms, an escaping path, invalid servers, templates (including sensitive `user_config` outside `env`), and extension conflicts all match Node's results.
8. Invalid params answer `-32602`. A host error answers `-32603` with its message. A process without the host answers `-32000`.
