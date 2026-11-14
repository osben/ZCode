# Rust agent: subagent runtime config from the Host (`subagents/readRuntimeConfig`)

Status: implemented in zcode-rs (`packages/rust-cli`). Parity row: `specs/fork-rust-agent-parity.md`, "Subagent runtime config".

## Background

The desktop Settings page owns the subagents a session may launch:

- the user's agents in `<storageRoot>/agents`;
- the project agents in `<workspace>/.zcode/agents`;
- the agents disabled in Settings (`disabledAgentIds` in `<storageRoot>/v2/agents-state.json`);
- the model chosen for the built-in `Explore` and `general-purpose` agents.

The Node CLI does not read those files when it runs under the desktop Host.

1. At session start it asks `session/requestRuntimePreferences` (scope `runtime-materialization`) and reads `subagentRuntimeConfigEnabled`.
2. When that flag is true, it asks the Host `subagents/readRuntimeConfig` at startup and again at the start of every parent turn. Each answer is the Host's resolved snapshot (`packages/shared/src/subagent-runtime-config.ts`):
   - `{kind: "ready", profiles, builtInModelSelectionOverrides, pluginAgentModelSelectionOverrides}`, where `profiles` holds only user and project profiles and the Host has already dropped the disabled user agents;
   - `{kind: "built-in-fallback"}` when the Host could not load a scope.
3. A failed read fails the turn (`createTurnAgentDefinitions`, core `subagent/definitions.ts`).

zcode-rs read `~/.zcode/agents` and the project directories itself and never asked the Host. So, on Rust:

- an agent disabled in Settings stayed available;
- the Settings model for `Explore` and `general-purpose` was ignored;
- a profile's full model selection (provider, model, reasoning level) was reduced to a model ID on the parent's provider.

## Owners

| State                                                          | Owner                                                                                 | Writers                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| Profiles, disabled agents, built-in and plugin agent overrides | Host (Settings, `agents-state.json`, profile parse cache)                             | Settings UI only; zcode-rs never writes them |
| Whether the Host offers the snapshot, per root session         | `protocol-zcode` `HostSubagentConfig` (answer of `session/requestRuntimePreferences`) | that port, once per root session             |
| The snapshot a session's agents come from                      | `agents` `AgentCatalog`, keyed by root session, tagged with the run that read it      | the catalog, at most once per parent run     |
| Which agents a request sees                                    | `AgentCatalog::prepared_definitions` / `definitions_in`                               | derived, not stored                          |

The port is a kernel-api trait (`subagent_config::SubagentConfigSource`). Only the desktop app-server installs it (`frontends/app_server.rs`). The standalone CLI, the TUI and headless runs have no source and keep reading files.

## Event order

```
parent run R1 of root session S starts
  └─ query step context (run start) ── listings ──▶ AgentCatalog::prepared(S, R1)
        cache for S is not tagged R1 ──▶ SubagentConfigSource::read(S)
           ├─ gate for S unknown ──▶ session/requestRuntimePreferences {sessionId:S, scope:"runtime-materialization", workspace}
           │     ◀── {subagentRuntimeConfigEnabled: true}            (remembered for S)
           └─ subagents/readRuntimeConfig {sessionId:S, workspace} ◀── {kind:"ready", ...}
        cache[S] = (R1, snapshot)
  ├─ tool-round listings in R1 ──▶ cache hit (no request)
  ├─ Agent tool call in R1 (ToolUseContext.run = R1) ──▶ cache hit
  └─ child run of a subagent of S ──▶ root_of(child) = S ──▶ cache[S] as it is (no request)
parent run R2 of S starts ──▶ a new read; cache[S] = (R2, snapshot')
```

## Product rules

1. **Gate.** zcode-rs asks `session/requestRuntimePreferences` once per root session, with `{sessionId, scope: "runtime-materialization", workspace}`, and reads only `subagentRuntimeConfigEnabled`.
   - JSON-RPC `-32601` or `-32020` means the Host does not offer it. Like Node's compatibility fallback, zcode-rs treats that as "disabled" and remembers it.
   - Any other error or the 15 s timeout fails the read and is not remembered: the turn fails and the next turn asks again.
   - A desktop-attached remote Host answers without the flag (it has no reader, `services/src/node.ts`), so zcode-rs keeps reading files there.
2. **Read.** When the gate is open, zcode-rs sends `subagents/readRuntimeConfig` with `{sessionId, workspace}`, where `sessionId` is the root session, and a 15 s timeout (`ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS`).
   - Both replies are validated against the App's zod schemas (inbound `replies`, generated by `scripts/fork-rust-agent/inbound-schema.mts`).
     The profile schema's `.readonly()` arrays carry the JSON Schema annotation `readOnly`, which the validator (`protocol-core` `schema.rs`) accepts and ignores.
   - A profile whose `source` is `built-in` is invalid. The schema's refinement is not representable in JSON Schema, so the Rust side checks it.
   - A transport error, a timeout or an invalid reply fails the read.
   - The `workspace` ref is the one `headers.rs` sends: `workspacePath` and `workspaceKey` are both the session's workspace path.
3. **Cadence.** The snapshot is read at most once per parent run, at the run's first catalog lookup (the run-start listing). The rest of that run uses it: the tool-round listings, the Agent tool and the compaction listings.
   - A subagent's runs use the latest snapshot of their root session and never send a request. Node children read `get()` and do not prepare their own.
   - A lookup without a run (compaction, `/context` usage) uses the cached snapshot. Only when there is none does it read once.
4. **A failed read fails the turn.** The run-start listing returns the error (`OrchestrationError::Failed`), so the parent run ends with it, as in Node. The cached snapshot is kept and not used for that run. An Agent call that has to read (a cache miss) and fails returns the error as its tool result.
   - A lookup that cannot fail (`/context` usage, the runtime's agent catalog for the app) logs the failed read as a warning and uses the agent files.
5. **Catalog from a `ready` snapshot.**
   - Layers, in order (a later layer replaces an agent with the same name):
     1. the built-ins, with the Settings overrides applied;
     2. the plugin agents;
     3. the snapshot's profiles, in the Host's order.
   - The files in `~/.zcode/agents` and the project directories are not read. The Host's project scope is `<workspace>/.zcode/agents` plus the session's additional directories, so Rust's walk from the cwd up to the git root no longer applies on this path.
6. **Catalog from `built-in-fallback`.** The built-ins only, without overrides and without plugin agents (Node `create-app.ts`).
7. **Built-in overrides.** `builtInModelSelectionOverrides.Explore` and `["general-purpose"]` set the full model selection of that built-in before the merge. A user or project profile with the same name still replaces the built-in outright.
   - **Plugin agent overrides.** `pluginAgentModelSelectionOverrides` is keyed by Node's plugin agent state id, `plugin:<plugin id>:<bare name, trimmed and lowercased>` (`createPluginAgentStateId`). The plugin id is the loaded plugin's `<name>@<marketplace>` (`<name>@inline` for `--plugin-dir`); the bare name is the agent file's frontmatter `name`, or the file name when there is none, without the namespace segments of the agent type. A matching entry sets that plugin agent's full model selection, replacing a `model:` it declares (Node replaces the whole selection before it adds the bare-name alias, `resolvePluginAgentProfiles`).
   - The overrides apply only with a `ready` snapshot; `built-in-fallback` has no plugin agents at all.
8. **Profile → agent definition.**
   - Fields that carry over:
     - `name` becomes the agent type;
     - `description` becomes the listing text;
     - `systemPrompt` is copied verbatim;
     - `tools`, `disallowedTools`, `maxTurns`, `background` and `permissionMode` carry over;
     - `modelSelection` becomes the agent's full selection.
   - A `permissionMode` value zcode-rs does not know is ignored.
   - Not used (no Rust counterpart today): `path`, `color`, `memory`, `skills`, `mcpServers`, `injectAgentsMd`.
9. **Model selection of a subagent with a full selection.**
   - The child runs on that provider and model, with the selection's reasoning level. The Agent tool's `effort` input (when given) replaces the reasoning level.
   - The account connection follows the parent only when the provider is the same; otherwise it is left for the platform to pick, like an App selection.
   - A selection the platform cannot serve fails the child's model request and is not replaced by the parent's model. Node refuses earlier ("Cannot start subagent: …"), so the text and timing differ.
10. **Incognito.**
    - Without custom agents, a session sees the built-ins and no request is sent.
    - Without plugins, the snapshot is still read and the plugin layer is dropped.
11. **Cache lifetime.** A session's cached snapshot and its remembered gate are dropped when the session closes (the runtime's per-session release, `SessionScoped::released`). A reopened session asks the gate and reads the snapshot again, as a Node runtime does at startup.
12. **Sessionless lookups.** `AgentCatalog::definitions(workspace)` serves the TUI and headless agent lists and has no session to key a snapshot on, so it reads files.

## Out of scope

- **Standalone CLI.** It does not honor `disabledAgentIds` the way the Node standalone CLI does (`bootstrap/src/subagents.ts` `readAgentState`).

## Acceptance

Unit tests:

- **`protocol-zcode`, gate.**
  - The gate request carries the root session, the scope and the workspace.
  - `-32601` and `-32020` mean disabled, and that answer is remembered (one request for two reads).
  - Another error fails the read and is not remembered.
  - A gate that answers without the flag means disabled.
- **`protocol-zcode`, read.**
  - The read request carries the root session and the workspace.
  - A `ready` reply maps to the snapshot with the full selections.
  - `built-in-fallback` maps to the fallback.
  - An invalid reply fails, and so does a `built-in` profile.
- **`agents`, catalog contents.**
  - A `ready` snapshot replaces the file layers: an agent in `~/.zcode/agents` and absent from the snapshot is not listed.
  - A plugin override keyed `plugin:<id>:<bare name>` sets that plugin agent's selection (a namespaced agent and a `model:` in its file included); another plugin's agent with the same bare name keeps its own model.
  - The built-in overrides set the selection, and a profile named `Explore` replaces the built-in.
  - `built-in-fallback` gives the built-ins only, without plugin agents.
  - With incognito custom agents excluded, no request is sent.
  - Without a source, the files are read.
- **`agents`, cadence.**
  - One parent run with two listings, an Agent lookup and a child's listing sends exactly one read.
  - The next run reads again.
  - After the session is released, the next lookup reads again (catalog), and the gate is asked again (`protocol-zcode`).
  - A failed read fails the listing; an Agent lookup that misses the cache returns the error.
- **`agents`, spawn selection.**
  - A full selection replaces the provider, model and reasoning.
  - The `effort` input wins over the selection's reasoning level.
  - The connection is kept only for the same provider.

Desktop E2E: run each spec on both runtimes in the container runner.

- `subagents/conversation-session-subagent-catalog-refresh` (SHR04–SHR08): add, rename, disable and re-enable an agent in a running session.
- `subagents/conversation-session-subagent-runtime-refresh` (SHR01–SHR03): the current turn keeps its config and the next turn's spawn uses the new one.
- `subagents/conversation-session-built-in-subagent-model-overrides` (I20).
- `subagents/conversation-session-subagent-runtime-catalog-reasoning`.
- `plugins/runtime/plugin-subagent-override-cold` (plugin agent override).

A case that fails on Node too is not a parity gap.
