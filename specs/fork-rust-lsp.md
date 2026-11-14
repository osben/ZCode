# Fork: language servers in the Rust agent

Status: stage 1 ("Protocol surface") and D1 ("Runtime") are implemented. Stage 2 is split the way Node shipped it (design §11, decision 4: diagnostics before navigation): D1 runs the servers and reports diagnostics after edits; D2 ("Tool", this PR) adds the `LSP` agent tool.

Node references: bootstrap `zcode-protocol/lsp.ts`, `app/lsp-preferences.ts`, `app/lsp-runtime-hub.ts`, `zcode-protocol-entrypoint.ts` (the LSP hub); adapters `plugins/lsp.ts`, `plugins/template.ts`, `lsp/command-resolution.ts`; contracts `lsp/index.ts`; design `apps/zcode-cli/docs/design/v2/tool/19-lsp.md`.

## Product rules

- The plugin page's language-server section lists the servers that the enabled plugins declare for the workspace it shows. For each server it shows its state, its extensions, and a diagnostics-after-edit toggle. A global switch turns language servers off.
- The switch and the toggles are user preferences. Both runtimes keep them in one sidecar, `<cliStorageRoot>/fork_lsp_preferences.json`. A change made under one runtime is what the other one reads. They are never stored in `setting.json` (AGENTS.md).
- Stage 1 starts no server. A declared server is `not_installed` when its command cannot be found, and `stopped` otherwise. D1 adds the running states (`starting`, `ready`, `crashed`, `unavailable`), document sync and diagnostics after edits. D2 adds the `LSP` agent tool.

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
    - `diagnosticsMode: "unknown"` (the protocol allows `pull`, `versioned`, `attributed` or `unknown`; with a running server D1 reports `pull` or `unknown`, see "Runtime");
    - `diagnosticsAfterEdit`: `prefs[id] ?? config.diagnostics ?? true`;
    - `restarts: 0`;
    - no `lastErrorCode`.

  D1 overlays the live pool entry whose key matches the request (see "Runtime", status).

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
                                   │  apply to the runtime (D1: the in-memory copy, then stop all servers when disabled)
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
  skill, MCP server, agent or hook (such as `typescript-lsp`) claims no name: it neither pushes out a plugin of the
  same name nor is pushed out by one loaded before it (a config-dir copy, for example); both load, as in Node, which
  dedupes by full id only.

- **Plugin data path.** `${CLAUDE_PLUGIN_DATA}` is `<storage>/data/<sanitized id>`, where every character outside
  `[A-Za-z0-9_.@-]` becomes `-` per UTF-16 unit like Node's regex, so an astral character gives `--`.

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
  - `user_config.<k>` comes from the merged config `plugins.options[id][k]`, else from the manifest `userConfig[k].default`. A missing value is an error, and so is a `sensitive` option outside `env`. Values are written the way JS `String(v)` writes them. Rust does not read the sensitive values Node keeps in `<cliStorageRoot>/plugin-secrets.json`; a server whose template needs one is skipped with a warning. The Rust MCP loader does not read that file either, so reading it is one follow-up for both (sensitive plugin options), not part of the LSP runtime.
  - `ZCODE_*` names come from the process environment; a missing one is an error.
  - Any other name is taken from the environment only in `env`. Outside `env` it is left as written.

  An error skips that server only.

- **Defaults.** `env` is the six plugin identity variables, with the server's own `env` on top. `workspaceFolder` must stay inside the workspace and is stored relative to it; an empty result means the workspace root. The timeouts default to 30 000, 5 000 and 60 000 ms. `restartOnCrash` defaults to true, `maxRestarts` to 3 and `diagnostics` to true.
- **Extension conflicts.** Servers are walked in admission order. The first server to claim an extension keeps it. A later server keeps its other extensions and is dropped when it has none left. The output stays in the original order.

## Install probe

- **Env.** The spawn env (see "Runtime", start): the stdio-server projection with the server's resolved `env` on top. On Windows, keys are compared case-insensitively.
- **Command with a directory part**, meaning it contains `/` or `\`, or is absolute: the command itself, resolved against the agent process's current directory, not the workspace.
- **Bare name:** each non-empty `PATH` entry joined with the name.
- **Windows:** `PATHEXT` candidates are tried as well (default `.COM;.EXE;.BAT;.CMD`), and quoted `PATH` entries are unquoted.
- **Test:** the candidate must be a regular file. Outside Windows it must also be executable.

## Runtime (D1)

This is a port of adapters `lsp/*` (JSON-RPC, pool, lifecycle, server requests) and core `lsp/*` (document sync, freshness, edit diagnostics, service) with the bootstrap hub and per-session wiring (`app/lsp-runtime-hub.ts`, `app/lsp-session.ts`) and the runtime call sites (`runtime/methods/lsp.ts`, `turn-loop.ts` `collectInputAttachments`, `tool/file-mutation.ts`, Read's prewarm). The design doc is `apps/zcode-cli/docs/design/v2/tool/19-lsp.md` §4–§6.

### Where it runs

- Only the app-server builds the runtime, as for stage 1. The TUI and `-p` have none (Node gives a plain CLI run a private hub; that stays a follow-up).
- Only the main thread of a session uses it. Node builds subagent runtimes without the LSP service, so a subagent's Read starts nothing, its Edit and Write publish nothing, and its requests carry no diagnostics.
- Only sessions on the local environment use it (the app-server serves local workspaces only).

### Owners

| Fact                                             | Owner                                                                                              | Notes                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server processes, states, restarts, capabilities | cli `lsp::runtime::Pool`, one per process                                                          | Node `createLanguageServerPool`. Entries are keyed by `(serverId, identity, workspacePath)`.                                                                                                    |
| One server's JSON-RPC stream                     | `lsp::runtime::rpc::Connection`                                                                    | Request ids, timeouts, `$/cancelRequest`, server-request answers. It knows nothing about lifecycle.                                                                                             |
| Open documents, versions, freshness              | `lsp::runtime::Documents`, one per process                                                         | Node `LspDocumentSync`: one store per `(serverId, identity, workspacePath)` and connection, 50 documents per store.                                                                             |
| Edits waiting for a report                       | `lsp::runtime::Tracker`, one per session                                                           | Node `EditDiagnosticsTracker`. Dropped with the session's runtime when the session closes (`CodeIntelligence::session_closed`).                                                                 |
| The servers a session can use                    | the session's `SessionLsp`, resolved once on first use                                             | Node resolves `servers` when the session runtime is built. A plugin change reaches the next session, as in Node.                                                                                |
| The session's identity key                       | the session store's workspace key (`workspaceID ?? directory`), falling back to the workspace root | The existing key, the same one `listed_key` and the App's `workspaceIdentity?.trim() \|\| workspacePath` produce.                                                                               |
| Preferences in memory                            | the host's shared preferences (`lsp::Host`)                                                        | Loaded from the sidecar on first use; every protocol `load` and `update` refreshes them inside the store's turn, so an older read never overwrites a newer write. Node `hub.preferences.get()`. |
| Hook points                                      | kernel-api `lsp::CodeIntelligence`, set on `Extensions`                                            | Read, Edit and Write call it; the context builder asks it for the report. The host implements it.                                                                                               |

### Event order

```
Read (main thread, text file, after the unchanged check)
  └─ CodeIntelligence::prewarm(session, workspace, path) ── acquire only, never waits

Edit / Write (main thread, after put_file succeeded)
  └─ CodeIntelligence::file_mutated(session, workspace, {path, kind, content, changedRange})
        │ synchronously: the next mutation ordinal n; tracker.record_syncing(n) (when diagnostics after edit is on)
        └─ the session's sync queue, in publish order ── under the tracker lock: pool.acquire_when(enabled)
              │                                           (off → tracker.remove_up_to(path, n), nothing starts)
              │                                           then the mark below
              ├─ failed   → tracker.remove_up_to(path, n)
              ├─ starting → tracker.mark_needs_sync(path, n)  (replayed on the server's ready event)
              └─ ready    → didChangeWatchedFiles, then documents.apply_mutation (didOpen | didChange | didClose)
                             → tracker.settle(path, baseline, n)   (a failed sync: remove_up_to(path, n))
                             → wake waiters

Server ──publishDiagnostics──▶ documents.handle_publish ──fresh──▶ wake waiters
Server ◀──textDocument/diagnostic── documents.request_pull (after each didOpen/didChange when pull is supported)

Model request (main thread, collected after the skills listing, before the plan-mode reminders)
  └─ CodeIntelligence::edit_diagnostics(session) ── no pending edit → None at once
        │ wait until every pending edit is fresh, at most until last mutation + 2000 ms (woken, never polled)
        │ consume: fresh → report; still pending → carried (dropped after 3 rounds)
        └─ attachment, source "diagnostics", committed to history like Node's `commitTurnRequestEntries`
```

Each tracker entry keeps the ordinal of the last mutation that recorded it. A step of mutation `n` settles, marks or removes the entry only while its ordinal is at most `n`; the first decided baseline is kept either way. So an older queued mutation whose sync fails or finishes cannot drop or settle the record of a newer edit of the same file (Node records and starts each sync synchronously, so it has no such interleaving). The `enabled` check is repeated in the queue because Node checks and acquires when the mutation is published: a mutation still queued when code intelligence is turned off starts no server. The pool reads the switch under its entries lock, the lock `stop_all` takes, and turning code intelligence off writes the switch before `stop_all`. So a start either happens first and `stop_all` stops it, or it reads the switch off. Prewarm goes through the same gate.

The consume step runs under one tracker lock, so a mutation published meanwhile stays pending. If the request is cancelled while waiting, its future is dropped before anything is consumed, so the pending edits stay for the next request (Node leaves the tracker untouched on abort).

### Pool

- **Acquire.** Never waits for a start. By state: `ready` gives the connection; `starting`, or a stop in progress, gives `starting`; `stopped` starts; `not_installed` starts again only 30 s after it was recorded; `crashed` restarts while `restartOnCrash && restarts < maxRestarts` (and counts the restart), otherwise it becomes `unavailable`; `unavailable` makes one more start per 30 s window, unless `restartOnCrash` is false (then it is final). A failed result carries `lsp_server_unavailable` "`{id} is unavailable after {n} restarts (last error: {code})`", or the entry's last code and message.
- **Capacity.** At most 4 live processes. Before a start, the least recently used servers with no request in flight are stopped to make room. When every candidate is busy the cap is exceeded and `lsp.cap_exceeded` is logged.
- **Idle.** A server with no use for 10 minutes and no request in flight is stopped gracefully. The idle timer is a task on the process scope.
- **Start.**
  - Env: the Rust stdio-server projection of the process environment (the same projection the Rust MCP stdio servers get) with the server's `env` on top (case-insensitive replacement on Windows). The install probe uses the same env.
  - cwd is the workspace path. The child gets its own process group, is recorded in the process ledger as `lsp`, and on Windows lives in the process job, like an MCP stdio server.
  - `initialize` with `startupTimeout`. Params: `processId`, `clientInfo {name: "zcode"}`, `rootUri`, `rootPath`, `workspaceFolders` (the workspace, plus the server's `workspaceFolder` when it differs; names are base names), `initializationOptions`, and the client capabilities below.
  - On success: `initialized`, then `workspace/didChangeConfiguration {settings}` when the server has `settings`; `restarts` returns to 0; the ready event goes out.
  - A spawn error with `NotFound` is `not_installed` (`lsp_server_not_installed`, "`command "{command}" was not found`"); any other spawn error is `crashed` with `lsp_server_start_failed`.
  - Exit or an invalid frame before `initialize` answered is `lsp_server_start_failed`; the message gets the last 2048 characters of stderr ("`; stderr tail: …`"). Exit after that is `lsp_server_crashed`. Neither the stderr tail nor a server's error text is logged; only codes are.
- **Client capabilities** (Node `LSP_CLIENT_CAPABILITIES`): `general.positionEncodings ["utf-16"]`; text document sync without dynamic registration and without `didSave`; `publishDiagnostics.versionSupport`; `diagnostic.dynamicRegistration`; `definition`, `references`, `implementation`; `hover.contentFormat ["markdown", "plaintext"]`; hierarchical `documentSymbol`; workspace `configuration`, `workspaceFolders`, `didChangeWatchedFiles` without dynamic registration, `symbol`.
- **Server requests.** `workspace/configuration` answers each item's dot-path lookup in `settings` (missing → null; no section → all settings); `client/registerCapability` and `client/unregisterCapability` (both `unregisterations` and `unregistrations`) keep the dynamic registrations; `window/workDoneProgress/create` answers null; `workspace/workspaceFolders` answers the folders; anything else answers `-32601` "`client does not implement {method}`".
- **Stop.** `shutdown` (with `shutdownTimeout`), then `exit`, then wait up to `shutdownTimeout`, then terminate the tree. Concurrent stops share one. Disabling code intelligence stops every server.
- **URIs.** `rootUri` and workspace folders encode each path segment like `encodeURIComponent` (on Windows the drive letter is lowercased and the colon kept). Document URIs follow `pathToFileURL`. A URI the server sends is matched after decoding it to a path and encoding it again, never as the raw string.

### JSON-RPC

- Frames are `Content-Length: N\r\n\r\n` plus N bytes of UTF-8 JSON. A header block longer than 8192 bytes without a terminator, a header line without `:`, a non-numeric or missing `Content-Length`, or a body that is not a JSON object is a protocol error: the server is treated as crashed (or failed to start).
- A request has a timeout (the server's `requestTimeout`, or the caller's shorter one) and the caller's cancellation. On either, `$/cancelRequest {id}` goes to the server and the request fails with `lsp_request_timeout` or `lsp_cancelled`.
- Error answers map: `-32800` → `lsp_cancelled`; `-32601` → `lsp_operation_unsupported` "`{id} does not support {method} (code c): {message}`"; others → `lsp_request_failed` "`{id} rejected {method} (code c): {message}`".
- Only the envelope (direction, method, id, error code) is logged, at `debug`. Params and results hold file contents.

### Documents and freshness

- First use of a file sends `didOpen` with version 1. A later edit sends a full-text `didChange` with version + 1. Before reusing an open document, its mtime and size are compared with the disk; drift re-reads it and sends a `didChange`. Deleting a file sends `didClose`. Each mutation also sends `workspace/didChangeWatchedFiles` with type 1 (created), 2 (changed) or 3 (deleted).
- Edits of one file are serialized (a per-URI lock that holds no guard across an await).
- A pull (`textDocument/diagnostic`) follows each `didOpen` and `didChange` when the server has `diagnosticProvider` or registered it dynamically. A `kind: "unchanged"` answer changes nothing.
- A result is fresh for the current version when it is a pull for that version, a publish with `version` ≥ the current one, or a versionless publish while exactly one change is in flight. With two or more changes in flight a versionless publish is ambiguous. Every publish resets the in-flight count.
- Diagnostics are converted to 1-based lines and code-point columns; a missing or unknown severity is an error.

### Diagnostics after edits

- An edit is tracked when diagnostics after edit is on for its server: the preference override, else the server's `diagnostics` (default true).
- **Report.** New issues are the multiset difference against the baseline (the last fresh result before the edit) on `(severity, code, message)`. Without a baseline, only issues whose lines overlap the changed range count. Info and hint are dropped. Errors come first, then path, line and column. The text is `Found N new diagnostic issues in M files`, then up to 20 lines of `path:line:col severity message [source code]` (the path relative to the workspace with `/`), then `... and K more`, then `Diagnostics pending for N files` when some files are still pending.
- **Changed range.** Write: a new file is lines 1..max(1, n); an overwrite is the lines between the common prefix and suffix. Edit: the union of the new-side hunks of its structured patch. Edits of one file merge their ranges.
- **Ready replay.** When a server becomes ready, the edits marked "needs sync" for that server and the same key are opened and settled without a baseline.
- **Log.** `lsp.edit_diagnostics` with server ids, error and warning counts, latency and whether a baseline was missing. Never paths or messages.

### Status

`lsp/status` overlays, for each declared server, the pool entry with the same server id, identity key (`workspaceIdentity?.trim() || workspacePath`) and workspace path: its `state`, `restarts`, `lastErrorCode`, and `diagnosticsMode` (`pull` when the server has `diagnosticProvider` or registered `textDocument/diagnostic`, else `unknown`).

### Differences kept on purpose

- The spawn env is the Rust stdio-server projection (an allow-list), not Node's full environment minus ZCode's own variables. It is the projection Rust MCP stdio servers already get.
- No Windows `.cmd` shim routing through `ComSpec` yet: the command is spawned directly. Node routes `.cmd`/`.bat` shims through `ComSpec`.

### Acceptance (D1)

1. JSON-RPC: frames split anywhere, several frames per chunk and multi-byte bodies decode; an oversized header and a malformed one fail the stream; timeout and cancellation send `$/cancelRequest`; error codes map as above; server requests get the answers above.
2. Pool on a paused clock: start → ready; crash → restart within the budget, `unavailable` after it, one more start after 30 s, final with `restartOnCrash: false`; `not_installed` retries after 30 s; idle stop after 10 minutes; the fifth start stops the least recently used idle server; a start failure carries the stderr tail.
3. Freshness: a versionless publish after one change is fresh; after two quick changes it is ambiguous and the edit stays pending; a versioned stale publish is ignored; a pull for the current version is fresh.
4. Diagnostics after edits: an edit followed by a fresh publish reports only new issues; a pre-existing issue that shifted lines is not new; without a baseline only the changed lines count; a still-pending edit reports `Diagnostics pending for 1 files` and is dropped after 3 rounds; an edit while the server starts is replayed on ready; cancellation leaves the pending edits; diagnostics after edit turned off for a server tracks nothing; quick edits of one file are synced in order; an older mutation whose sync fails keeps the newer pending edit; a mutation queued when code intelligence is turned off starts no server.
5. Status shows `starting`, `ready`, `crashed` and `unavailable` for the matching key only, and `pull` for a pull server.
6. Disabling code intelligence stops every running server.
7. One real-process test drives a small fake server binary through start, an edit and its diagnostics.
8. No desktop E2E spec covers language servers, and the E2E box has no language server installed, so this stage has no E2E run.

## Tool (D2)

This is a port of Node's `LSP` agent tool: contracts `tools/lsp.ts`, core `tool/handlers/lsp.ts`, `tool/handlers/lsp-format.ts`, `lsp/query-runner.ts`, `lsp/operations.ts`, `lsp/position.ts`, `lsp/results.ts`, `lsp/operation-output.ts`, and its gating in `runtime/methods/lsp.ts`, `runtime/helpers/tool-allowlist.ts` `resolveRuntimeLspToolIncluded` and `tool/handlers/index.ts` (`includeLsp`). The design doc is `apps/zcode-cli/docs/design/v2/tool/19-lsp.md` §7.

### When the tool is offered

Node registers `LSP` in a session runtime only when all of these hold (`includeLsp`):

- the runtime has an LSP service: the main thread of a session in a process with the hub, with at least one server declared for its workspace;
- code intelligence is enabled;
- at least one declared server's command is installed (`LspService.isAvailable`).

Node computes this when the runtime is built and again after each preference change (`applyLspPreferences`); the turn loop awaits the pending computation (`settleLspPreferences`) before it reads the tool set. A subagent runtime has no LSP service, so no subagent (Explore included) ever has the tool.

Rust:

- Only the app-server has the tool: it is registered when the assembly has the code-intelligence port (the `lsp::Host`), the same condition as D1.
- **Owner.** The host keeps one availability fact per session: the workspace it was computed for and the answer. `CodeIntelligence::settle_tool(session, workspace)` computes and stores it: off when code intelligence is disabled, off when the session's runtime has no declared server (a workspace in another environment, or one whose workspace identity is remote, has none: Node `create-app.ts` declares no servers for a remote identity), else whether any declared server is installed (the same install probe and env as `lsp/status`).
- **When it is computed.** The main thread's runner calls `settle_tool` before every main-thread run, before the run's first tool snapshot. Only the first call for the session's workspace computes the fact (Node computes it when the runtime is built); a later call for the same workspace keeps it, as Node's turn-start `settleLspPreferences` only awaits a pending computation. A move to another workspace computes it anew. `lsp/preferences/set` recomputes the fact of every session that has one before it answers (Node's `applyLspPreferences` for every registered runtime). `session_closed` drops it. So an install mid-session shows the tool only after a preference write, and an uninstall keeps it: the query then answers `lsp_server_not_installed`.
- **Who reads it.** One registry layer under the permission filter owns the tool's visibility: it adds `LSP` to a session's snapshot and resolves it by name for that session (`find_for`) only while `CodeIntelligence::tool_offered(session)` is true. That sync read is "enabled now and the stored fact is true", so turning code intelligence off hides the tool at once. Every consumer of the session view goes through this layer: the main loop's step snapshot, ToolSearch (search and the deferred listing), the executor's lookup, `system/init` and `/context`. Lookups without a session (`tools`, `find`) never return it.
- **Subagents.** The subagent tool filter and the fork child's registry hide `LSP` for every child, like the main-session-only Cron tools, because the session-keyed fact would otherwise reach a child of an offered session.

```
main-thread input ─▶ runner: CodeIntelligence::settle_tool(session, workspace) ── awaited
                          │   fact[session] for this workspace? keep it
                          │   else (prefs enabled? → session runtime has servers? → any installed?) → host fact[session]
                          ▼
                     query loop: StepTools::refresh ─▶ registry snapshot(session)
                                                       └─ LSP layer: tool_offered(session) = enabled && fact[session]
lsp/preferences/set ─▶ write sidecar ─▶ remember prefs ─▶ (off: stop_all) ─▶ recompute fact[s] for every known s
session close ─▶ CodeIntelligence::session_closed ─▶ drop fact[session]
```

### Contract

- Name `LSP`. The description is Node's four sentences joined by a space. The input schema is `prompts/tools/LSP.json`, generated from Node's `LspInputJsonSchema` (`operation` enum of seven operations, `filePath` required; `line`, `character` numbers; `symbol`, `query` strings; `includeDeclaration` boolean). Unknown keys are stripped (`z.object`).
- Deferred behind ToolSearch (`shouldDefer`), read-only, concurrency-safe, no search hint.
- Permission: Node's `read` class with no approval (`permission/service.ts`): whole-tool `LSP` deny and ask rules apply; content rules never match, since `ruleSubjects` reads only `command`, `url`, `file_path`, `path`, `pattern` and `patch_text` (the declared `patternSources` have no reader); then `checkBuildMode` allows a read-only tool without approval in every mode. Rust's tool has no permission subject and its own check allows, so the chain keeps whole-tool deny and ask rules and never asks for a path, the workspace's outside included.
- Timeout 65 s: the call fails with "Tool execution timed out after 65000ms". Result budget: Node's `resultBudget` (`LSP_MODEL_MAX_BYTES`, the artifact strategy). A result above 100 000 UTF-8 bytes is persisted, and the model gets Node's generic envelope (`formatGenericPersistedOutputContent`): the size in decimal units of its UTF-8 bytes and the first 2000 characters. Rust's tool declares the byte budget (`Tool::result_budget_bytes`) in place of the shared character budget and its 50 000 cap.
- `display` is Node's `LspOutput` object; the model sees the formatted text below.

### Call order

1. Input rules the schema cannot express (each a tool error, Node `validateOperationInput`):
   - `workspaceSymbol` with a missing or empty `query`: "workspaceSymbol requires query".
   - A positional operation (`goToDefinition`, `findReferences`, `hover`, `goToImplementation`) without `line`: "`{op}` requires line"; with both or neither of `character` and `symbol`: "`{op}` requires exactly one of character or symbol".
2. No runtime for the session: "LSP service is not configured for the LSP tool".
3. `filePath`: empty is "Tool path must not be empty"; an absolute path is normalized; a relative one is resolved against the session's current directory (no `~` expansion, Node `path.resolve`).
4. The query (Node `runLspQuery`), each failure with Node's stable code and text:
   - disabled: `lsp_disabled` "Code intelligence is turned off";
   - no server for the file's extension: `lsp_no_server_for_file` "No language server is configured for `{op}` on this file type";
   - the server's command is not installed: `lsp_server_not_installed` "Language server `{id}` is not installed on this machine";
   - acquire: `starting` is `lsp_server_starting` "Language server `{id}` is starting; retry shortly; use Grep meanwhile"; a failed acquire passes its code and message through;
   - the operation's server capability (`definitionProvider`, `implementationProvider`, `referencesProvider`, `hoverProvider`, `documentSymbolProvider`, `workspaceSymbolProvider`; none for `diagnostics`) is not truthy in the initialize result: `lsp_operation_unsupported` "Language server `{id}` does not support `{op}`";
   - `workspaceSymbol` sends `workspace/symbol {query}` without opening the file;
   - every other operation opens the file (or re-syncs a drifted one) through the shared documents, then:
     - `diagnostics` waits up to 2000 ms for a result fresh for the current version (woken by the documents, never polled). Fresh gives `status: "ok"` with the error and warning items; still not fresh gives `status: "pending"` with no items.
     - positional operations resolve the position against the synced text, then send `textDocument/definition`, `implementation`, `references` (`context.includeDeclaration`, default false) or `hover`; `documentSymbol` sends `textDocument/documentSymbol`.
   - Request failures keep D1's codes (`lsp_request_timeout`, `lsp_cancelled`, `lsp_request_failed`, `lsp_operation_unsupported`, `lsp_server_crashed`). Cancelling the tool call cancels the request (`$/cancelRequest`).
   - The model sees each failure's message as a tool error.

### Positions

- Model side: 1-based line, 1-based column counted in code points. LSP side: 0-based line, UTF-16 column. Lines split on LF with one trailing CR removed.
- `line` must be an integer in 1..lines: "Line `{n}` is outside the file (1-`{count}`)" (`lsp_invalid_position`).
- `symbol` wins: its first whole-word occurrence on the line, whole word meaning neither neighbour is `[\p{L}\p{N}_$]`; none is `lsp_symbol_not_found_on_line` "Symbol "`{s}`" does not occur as a whole word on line `{n}`".
- `character` must be an integer ≥ 1: "Column must be a positive integer, got `{c}`"; the end-of-line column is allowed, past it is "Column `{c}` is past the end of the line".
- Numbers print as JavaScript prints them (`1.5`, `2`).

### Results

- Locations (definition, implementation, references): `Location | Location[] | LocationLink[] | null`; a link uses `targetSelectionRange`, else `targetRange`; malformed items are skipped. Each becomes `{path, line, character, endLine, endCharacter, preview}`: the path relative to the workspace with `/` when inside it (D1's `model_path`), 1-based code-point positions read from the target file (read once per file per call; an unreadable file keeps the server's columns plus one), and a preview of the start line, trimmed and cut to 200 code points.
- Symbols: a `DocumentSymbol` tree is flattened depth first (`selectionRange`, children get the parent's name as `containerName`); `SymbolInformation` uses `location` and its own `containerName`. Kinds map to Node's names (`file` … `typeParameter`, else `unknown`). Each becomes `{name, kind, path, line, containerName?}`.
- Hover: `MarkupContent`, `MarkedString` or an array of them, joined by a blank line and trimmed; empty gives no `hover`; longer than 2000 UTF-16 units is cut and gets `\n...(truncated)`.
- Lists are capped at 200 items: `truncated` and `total` (the uncapped count). Hover has no `total`.
- A URI that is not a decodable `file:` URI fails the call ("The URL must be of scheme file"), as Node's `fileURLToPath` throws.

### Model text (Node `formatLspModelContent`)

- One line per location `path:line:character  preview` (trailing spaces trimmed), per symbol `kind name[ in container]  path:line`, the hover text, and per diagnostic `path:line:character severity message[ [source code]]`.
- `pending` adds "Diagnostics pending: the language server has not reported fresh results for this file yet. This is not the same as no errors." for `diagnostics`, else "Result pending: the language server has not answered yet. Retry shortly, or use Grep meanwhile."
- Nothing to show: "No diagnostics reported" for `diagnostics`, else "No results".
- Truncated lists end with "(Results are truncated. Narrow the query to see the rest.)".

### Differences kept on purpose (D2)

- The persisted location is Rust's `zcode-artifact://` reference, not Node's artifact path. When the artifact cannot be stored, Rust returns the result whole; Node falls back to its head truncation with the `[Tool output truncated by resultBudget: ...]` suffix.
- A cancelled call settles as the pipeline's generic cancellation, without Node's `userVisibleMessage` text.
- A file the documents cannot read fails with the environment's error text, not Node's `FileSystemPort` text.
- The TUI and `-p` still have no LSP runtime, so they have no `LSP` tool (D1).
- Rust's built-in Explore description does not list `LSP` (Node's static Explore tool list names it, though no subagent can use it). Explore's Rust description follows its own port and is not changed here.

### Acceptance (D2)

1. Golden texts produced by Node's own `projectOperationResult`, `projectDiagnostics` and `formatLspModelContent` match the Rust projection and text for: a Location, a Location array, LocationLinks, null, a DocumentSymbol tree, SymbolInformation, each hover form and its truncation, 201 references (truncation), and pending diagnostics.
2. Position resolution: CRLF lines, a surrogate pair before the column, the end-of-line column, `use` not matching `user`, and every error text.
3. Input rules and their texts, before any runtime access.
4. Through the fake pool: a starting server answers `lsp_server_starting`; a missing capability answers `lsp_operation_unsupported`; definition opens the file and projects the answer; `workspaceSymbol` opens nothing; `diagnostics` is `pending` without a fresh result and `ok` with one; cancelling the call sends `$/cancelRequest`.
5. Gating: offered only when enabled and a server is installed; hidden at once after disabling and offered again after enabling; absent for a session without declared servers; absent in subagents and fork children; ToolSearch neither lists nor loads it while hidden; the executor cannot resolve it while hidden.
6. No desktop E2E spec covers language servers and the E2E box has no language server, so D2 has no E2E run.

## Differences kept on purpose (stage 1)

- Node's MCP stdio env puts the running Node binary's directory in front of `PATH` when the agent itself is a `node` process. The Rust agent is not, so it adds nothing.
- Node creates each enabled plugin's data directory while resolving. Rust's status call writes nothing except the sidecar on `set`.
- Rust has no plugin diagnostics list. Skipped servers and plugins are logged (`warn`) instead.

## Acceptance (stage 1)

1. `lsp/preferences/get` with no sidecar answers `{enabled: true, diagnosticsAfterEdit: {}}` and creates no file.
2. A Node-written sidecar is read back unchanged. A Rust-written sidecar parses under Node's `LspPreferencesSchema` and matches Node's text byte for byte. Both runtimes check this against one golden file, `packages/rust-cli/crates/cli/src/lsp/fixtures/fork_lsp_preferences.json`: the Rust test `the_patch_sequence_writes_the_golden_sidecar` and the fork Vitest `lsp-preferences-sidecar.test.ts` apply the same three patches (including a removal, a key that needs escaping and a non-ASCII key) and compare the bytes.
3. `set` with `{diagnosticsAfterEdit: {"a/x": false}}` and then `{enabled: false, diagnosticsAfterEdit: {"a/x": null, "b/y": true}}` leaves `{1, false, {"b/y": true}}`. A file edited between the two calls keeps the edited keys.
4. An invalid sidecar (bad JSON, `version: 2`, or an extra key) reads as the defaults. `set` replaces it. A sidecar that cannot be read, because it is a directory, fails `set` and stays as it was.
5. `lsp/status` for a workspace whose only LSP plugin is the official `typescript-lsp` lists `typescript-lsp@zcode-plugins-official/typescript` with its eight extensions in declaration order. The state is `stopped` when `typescript-language-server` is on `PATH` and `not_installed` otherwise.
6. A workspace that disables a plugin in its own config omits that plugin's servers, while another workspace served by the same process still lists them.
7. Declarations: the file plus manifest merge, the wrapper, array and path forms, an escaping path, invalid servers, templates (including sensitive `user_config` outside `env`), and extension conflicts all match Node's results.
8. Invalid params answer `-32602`. A host error answers `-32603` with its message. A process without the host answers `-32000`.
