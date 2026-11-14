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
   - Any other error or the 15 s timeout fails the read and is not remembered: the turn fails and the next turn asks again. The error keeps the Host's JSON-RPC code and message.
   - A Host that promised the attach acknowledgement (`ZCODE_HOST_ATTACH_ACK=1`) drops reverse requests sent before it. Like the credential cipher (`cipher.rs`) and the request headers (`headers.rs`), both requests first wait for the acknowledgement inside the same 15 s bound. If it does not arrive, nothing is sent and the error names the attach (`the host did not acknowledge the attach in time before <method>`), not the request.
   - A desktop-attached remote Host answers without the flag (it has no reader, `services/src/node.ts`), so zcode-rs keeps reading files there.
2. **Read.** When the gate is open, zcode-rs sends `subagents/readRuntimeConfig` with `{sessionId, workspace}`, where `sessionId` is the root session, and a 15 s timeout (`ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS`).
   - Both replies are validated against the App's zod schemas (inbound `replies`, generated by `scripts/fork-rust-agent/inbound-schema.mts`).
     The profile schema's `.readonly()` arrays carry the JSON Schema annotation `readOnly`, which the validator (`protocol-core` `schema.rs`) accepts and ignores.
   - A profile whose `source` is `built-in` is invalid. The schema's refinement is not representable in JSON Schema, so the Rust side checks it.
   - So is a model selection (a profile's, a built-in override's or a plugin override's) whose `providerId`, `modelId` or `options.reasoningLevel` is blank after trimming: Node's `modelSelectionSchema` is `z.string().trim().min(1)`, so the whole reply fails to parse. JSON Schema cannot say "non-empty after trimming" either.
   - A transport error, a timeout or an invalid reply fails the read.
   - The `workspace` ref is the one `headers.rs` sends: `workspacePath` and `workspaceKey` are both the session's workspace path.
3. **Cadence.** The snapshot is read at most once per parent run, at the run's first catalog lookup (the run-start listing). The rest of that run uses it: the tool-round listings, the Agent tool and the compaction listings.
   - A subagent's runs use the latest snapshot of their root session and never send a request. Node children read `get()` and do not prepare their own.
   - A lookup without a run (compaction, `/context` usage) uses the cached snapshot. Only when there is none does it read once.
   - Only a main-thread run is a parent turn. A compaction's summary run and a side request (title, WebFetch summary, prompt hook) run with a fresh run id, but their lookups use the cached snapshot like a lookup without a run, and the parent run's next lookup still does not read.
   - This matches Node's order. Node's `get()` returns the last prepared snapshot and `prepareAgentDefinitions` runs at turn start (core `subagent/definitions.ts`, `runtime/methods/turn.ts`). A manual `/compact` returns before that step, and the `/context` preview reads the last snapshot (`runtime/context-composition/preview.ts`). In zcode-rs an in-run auto-compaction comes after the run-start listing (`query` `run`: `start` before the loop's `before_request`), so it reads that run's snapshot.
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
     - `tools`, `disallowedTools`, `maxTurns`, `background` and `permissionMode` carry over (a `maxTurns` above `u32::MAX` becomes `u32::MAX`: Node's schema has no upper bound, so it stays a limit);
     - `modelSelection` becomes the agent's full selection.
   - A `permissionMode` value zcode-rs does not know is ignored.
   - `injectAgentsMd` carries over (rule 15).
   - Not used:
     - `path` and `color`: the Node runtime does not read them either (`color` is set only on the built-in profiles in core `subagent/profile.ts`; the Settings page reads it from its own files).
     - `memory`, `skills` and `mcpServers`: open gaps. zcode-rs supports none of them for agent files either, so each is its own feature, not part of this snapshot:
       - `memory`: Node loads the agent's persistent memory into its prompt (`loadPersistentAgentMemory`, core `runtime/methods/subagent.ts`) and adds the memory tools (`projectPersistentAgentMemoryTools`, `runtime/agent-runtime.ts`).
       - `skills`: an allowlist, not a preload. Node adds the `Skill` tool and limits the child's skill listing and loads to the granted skills (`runtime/methods/subagent.ts`, `resolveSubagentSkillGrants`).
       - `mcpServers`: Node scopes the child's borrowed parent MCP servers to the listed names (`runtime/methods/subagent.ts`, `createBorrowedSubagentMcpAccess`).
9. **Model selection of a subagent with a full selection.**
   - The child runs on that provider and model, with the selection's reasoning level. The Agent tool's `effort` input (when given) replaces the reasoning level.
   - A plugin agent's file `effort:` does not: Node's profile has no effort, so a Settings override's reasoning level is the whole intent. The override clears the file's `effort` (at spawn and on a resume). Without an override the file's `effort` stays, as before.
   - The account connection follows the parent only when the provider is the same; otherwise it is left for the platform to pick, like an App selection.
   - **Up-front check (desktop).** Node resolves an agent's own selection before the child starts (core `runtime/helpers/subagent-selection.ts` `resolveSubagentSelection`, through the Host's `resolveEffectiveModelSelection`). On the desktop (`node_desktop`) zcode-rs checks the definition's selection (a Host profile's `modelSelection` or a built-in override, which Node also applies as the profile's `modelSelection`) against the model catalog, before the merge with the parent connection and the `effort` input:
     - no catalog entry with that provider: `provider-not-found`;
     - the provider has no such model: `model-not-found`;
     - no reasoning level: `reasoning-level-missing`;
     - a level the model does not offer: `reasoning-level-not-supported`.
   - On an issue the Agent call fails with Node's text `Cannot start subagent: <message> [reason=<reason>; selection=<provider>/<model>]`, with Node's messages (for example `Model unavailable / 模型不存在或不可用`). As in Node (the session-ready gate in core `subagent/runner.ts`), the call itself fails, in the foreground and in the background: no child session, no background task, no model request, and the parent's model is not used instead.
   - A SendMessage resume (rule 13) checks the current definition the same way and fails the SendMessage call with the same text; the agent keeps its old state, as Node restores its previous task.
   - Not checked, as in Node: an agent with no selection (it inherits the parent's) and a `model` from an agent file.
   - Remaining differences: Node remaps an account-plan provider to the single current account (otherwise `account-connection-unavailable`) and maps a legacy reasoning level before it reports `reasoning-level-not-supported`; zcode-rs matches the catalog's provider and model as given and does neither. Node also hides a hidden provider; the zcode-rs catalog already leaves those out. There is no check outside the desktop or without a model catalog (an explicit API key).
10. **Incognito.**
    - Without custom agents, a session sees the built-ins and no request is sent.
    - Without plugins, the snapshot is still read and the plugin layer is dropped.
11. **Cache lifetime.** A session's cached snapshot and its remembered gate are dropped when the session closes (the runtime's per-session release, `SessionScoped::released`). A reopened session asks the gate and reads the snapshot again, as a Node runtime does at startup.
12. **Sessionless lookups.** `AgentCatalog::definitions(workspace)` serves the TUI and headless agent lists and has no session to key a snapshot on, so it reads files.
13. **A SendMessage resume re-resolves the agent (desktop).** Node resumes a finished agent from the current profiles (`resumeTerminalAgentInBackground`, core `subagent/runner.ts`). On the desktop (`node_desktop`), zcode-rs does the same when SendMessage restarts a finished or parked agent:
    - It looks the agent type up in the parent's current catalog (the same lookup as the Agent tool, so in a parent run it uses that run's snapshot).
    - When the type is gone (removed, renamed or disabled in Settings), the call returns Node's text `Cannot resume local agent <agentId>: profile <agentType> is unavailable.`. The result is not an error, and no run starts.
    - When the type is found, the resumed run uses the current definition: its prompt, tools, maximum turns and permission mode, and the model from its selection (or the parent run's current model when it has none). Node's Agent tool has no `effort` input, so a resume keeps no per-call reasoning level.
    - The resume stores the model and the permission mode it runs with in the child session when they differ from the stored ones (`ModelSelected`, `ModeChanged`), so reopening the child shows them. Node stores the resumed selection on every resume (`persistRuntimeModelSelection`, core `runtime/methods/subagent.ts`).
    - A failed Host read returns the error as the tool's result (rule 4).
    - The TUI keeps the definition the agent started with. So do the restarts SendMessage does not start: a parked agent woken by a notice, and a message that arrived after a stop and resumes the stopped run once it settles.
14. **No `Plan` agent on the desktop.** Node has two built-in agents, `general-purpose` and `Explore` (core `subagent/profile.ts` `normalizeAgentProfiles`). Under `node_desktop` the zcode-rs catalog leaves out its own built-in `Plan` on every path: a `ready` snapshot, `built-in-fallback`, the agent files and incognito without custom agents.
    - `subagent_type: "Plan"` is then an unknown type, with Node's text `Agent type 'Plan' not found. Available agents: …` (core `subagent/runner.ts`). A profile named `Plan` is an ordinary agent.
    - The TUI and headless runs keep `Plan`.
15. **Project instructions of a subagent follow `injectAgentsMd`.** Node gives a child the AGENTS.md instructions unless its profile says `injectAgentsMd: false` (core `runtime/methods/subagent.ts`); only the built-in `Explore` says so (core `subagent/profile.ts`), and a user or project profile named `Explore` is not the built-in (`isBuiltInExploreAgentProfile` checks the source).
    - zcode-rs carries the flag on the agent definition: true for the built-in `general-purpose`, false for the built-in `Explore` (and the TUI's `Plan`); a Host profile or an agent file takes `injectAgentsMd` (a boolean or the strings `true`/`false`, as Node's parser), true when absent.
    - A child whose definition has it false gets no rule files, nested rules or git status, which is what the built-in `Explore` lost before by name. The decision no longer looks at the agent's name, so a profile named `Explore` keeps them.
    - It applies on both surfaces (the TUI as well), as in Node.
    - The child's auto-compaction follows it too. In Node the child runtime's context builder has no user instructions at all, compaction included. In zcode-rs the child run carries the flag (`QueryRequest::inject_agents_md`) into its compaction request and the summary run, so the summary request does not re-announce the rule files or the session context.
    - Git status: Node gives no child the git status (the child's `createSubagentContextBuilder`, core `runtime/methods/context.ts`, has no project context). On the desktop (`node_desktop`, `ContextConfig::subagent_git_status` off) no zcode-rs subagent gets it either, whatever its `injectAgentsMd`, and neither does a child's summary request; the main thread keeps it. The TUI keeps it for a child with the flag on.

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
  - A compaction or side lookup with a fresh run id does not read, and neither does the parent run's next lookup.
- **`agents`, spawn selection.**
  - A full selection replaces the provider, model and reasoning.
  - The `effort` input wins over the selection's reasoning level.
  - The connection is kept only for the same provider.
  - A plugin override clears the file's `effort`; without an override it stays.
- **`agents`, resume (rule 13).**
  - After the profile changes, a SendMessage resume runs with the new prompt and model.
  - The resume stores the new model and permission mode in the child session.
  - After the profile is removed, SendMessage returns Node's "profile is unavailable" text and starts no run.
- **`query`, `compact`, `context`, child compaction (rule 15).**
  - The run's `inject_agents_md` reaches its context requests and its compaction request; the summary run carries it.
  - A child's summary request with the flag off announces only the date; a desktop child's has no git status.

Desktop E2E: run each spec on both runtimes in the container runner.

- `subagents/conversation-session-subagent-catalog-refresh` (SHR04–SHR08): add, rename, disable and re-enable an agent in a running session.
- `subagents/conversation-session-subagent-runtime-refresh` (SHR01–SHR03): the current turn keeps its config and the next turn's spawn uses the new one.
- `subagents/conversation-session-built-in-subagent-model-overrides` (I20).
- `subagents/conversation-session-subagent-runtime-catalog-reasoning`.
- `plugins/runtime/plugin-subagent-override-cold` (plugin agent override).

A case that fails on Node too is not a parity gap.

The refresh specs (`subagent-refresh-capture.ts`, and the explicit tool lists in the model-override and reasoning specs) expect Node's child tool list, which includes `RespondToCoordinator`. zcode-rs has no such tool. That is a separate parity gap, outside this spec, so on Rust these specs run from a copy without that one tool name.

Results on Rust (2026-11-13). The following failures are not gaps of this spec:

- `runtime-refresh` passes.
- `catalog-refresh`: the `user` case passes. The `mcs` case fails afterwards, at the provider-prefix check. When a request ends with a mid-conversation system message, Rust puts the message cache breakpoint on that system message. Node puts it on the latest non-system message (`finalizeLatestNonSystemMessageCacheControl`, core `runtime/helpers/provider-request-messages.ts`); the Rust counterpart is `query` `normalize.rs`. That is a request-shaping gap, outside this spec.
- `plugin-subagent-override-cold` passes on Node but fails on Rust: zcode-rs skips the whole `documents` plugin, because its MCP server runs in the Node CLI plugin host (`ext` `plugins/select.rs`, `NodeDependency::PluginHost`). Its agents are never loaded, so `documents:visual-judge` is not found. That gap belongs to the plugin host work. The override mapping itself is covered by the `agents` unit tests.
- `built-in-subagent-model-overrides` (an E2E helper import is missing), `runtime-catalog-reasoning` (the custom form overflows horizontally) and `subagent-coding-plan-login-catalog-stale` (the OAuth URL is not captured) fail on Node too.
