# ACP agent runtime: external agents as ZCode providers (phases 1–3)

External ACP agents (`opencode`, `cursor-agent`) become ZCode providers: ZCode drives them over
newline-delimited JSON-RPC (Agent Client Protocol) on stdio, and Model Settings exposes detection,
activation, a roundtrip Test with raw frames, and login helpers. This spec is the product contract
for `packages/acp-agent-runtime` (lifecycle core), the `acp-agent` provider access type, and the
settings bridge/UI. Chat turn delegation (phase 4) is a follow-up.

Wire behavior was verified against `opencode` v2.0.31 and `cursor-agent` 2026.05.01 (spike traces);
the mock-agent tests encode the contract below.

## Product rules

- Agents are user-installed CLIs; ZCode never installs, updates or logs them in silently. Detection
  probes fixed binaries on the login-shell PATH (`opencode`, `cursor-agent` — never bare `agent`,
  which collides with unrelated CLIs) with fixed version-probe arguments only.
- An enabled agent becomes the personal provider `acp:<agentId>` with one synthetic model
  (`modelId = agentId`); ids are stable and validated (not taken, no whitespace). Until phase 4 the
  model stays out of the chat registry (`executable = false`). The provider is derived from the
  fork-owned sidecar store, never written to `provider_config.json` (see "Storage and upstream
  compatibility").
- Permissions are answered by `kind` (`allow_once` / `allow_always` / `reject_once` /
  `reject_always`); an unavailable kind resolves to `cancelled`. Agents never see host-specific
  option ids.
- A permission ask reaches the host only for the live turn — current generation and session while
  `prompting`. Stale (restarted), orphaned (torn down or out-of-turn) and foreign-session asks are
  answered `cancelled`: never surfaced, never implicitly allowed.
- Environment: every child ZCode spawns for an agent — the ACP session process, the detection
  version probe and the auth-status command — inherits the parent env through the one shared
  builder (`buildChildEnv`), minus (a) privileged ZCode runtime keys via the shared sanitizer and
  (b) secret-named keys by segment. User capability sockets (`SSH_AUTH_SOCK`, `KRB5CCNAME`,
  `GPG_AGENT_INFO`, …) are intentionally inherited — the agent is unsandboxed and acts for the
  user; explicit launch `env` overrides win, and `undefined` deletes. Exception: an explicit
  override may never _set_ a loader/injection key (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`,
  matched case-insensitively); deleting one with `undefined` is allowed, and values inherited from
  the parent env are left to the user's own shell setup.
- Launch rules (one shared validator, `@zcode/shared/acp-launch-rules`, used by the runtime launch
  validation, the provider config `acp-agent` complete schema and the settings bridge): `command`
  is non-blank, at most 4096 characters; at most 32 `args` of at most 4096 characters; neither may
  contain NUL, CR or LF (a line break would let a command escape any line-oriented script it is
  embedded in). At most 64 env overrides; keys match `[A-Za-z_][A-Za-z0-9_]*` and are not
  loader keys; values are at most 8192 characters without NUL. The loader key list covers the
  library loaders (`LD_*`, `DYLD_*`), the interpreter startup hooks (`NODE_OPTIONS`, `BASH_ENV`,
  `ENV`, `ZDOTDIR`, `BASH_FUNC_*`, `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PERL5OPT`,
  `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`) and the git exec hooks
  (`GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `GIT_ASKPASS`, `GIT_PROXY_COMMAND`). It is one list
  in `@zcode/shared/acp-launch-rules`. It is defence in depth for the launch config, not a sandbox:
  the agent command still runs with the user's privileges. A stored provider that violates the
  rules still loads (the sparse stored shape stays structural) but fails complete validation, so it
  is reported invalid and never launched.
- Login helper (macOS): the terminal script prints the command with `printf '%s\n'` and a
  single-quoted argument, then runs it; the command line is never embedded in a heredoc or any
  other construct a crafted line could terminate.
- One active prompt per session. `cancel` sends a bounded `session/cancel` and escalates to a
  process-tree kill; `stop` is idempotent and safe to call at any time.

## State owner and lifecycle

Owner: one `AcpSessionRuntime` per agent process.

- States: `starting` → `ready` ⇄ `prompting`; terminal per process: `failed` or `stopped`.
- A prompt issued while `failed` transparently restarts the process and session.
- Teardown (`stop`, escalated cancel, handshake failure, fatal transport
  failure — an oversized frame or a closed stdout, even when the child process
  survives) marks the runtime `failed` (unless it is already `stopped`) BEFORE
  rejecting in-flight asks/prompts, so no rejected prompt can fall back to
  `ready` with a cleared connection; the next prompt then restarts. Every
  teardown answers pending permission asks `cancelled` before rejecting the
  prompt.
- `stopped` is terminal for the runtime: once `stop()` was called no later
  path (a failed cleanup, an exit or stream failure racing the stop, a prompt
  or `restart()`) moves it back to `failed`, `starting` or `ready`. A cleanup
  that leaves processes behind keeps ownership (a later `stop()` retries) and
  reports `process_cleanup_failed`, but the state stays `stopped`.
- A failed handshake always rejects with the handshake error; a cleanup
  failure during that teardown is reported (`process_cleanup_failed` event and
  a service log) but never replaces the handshake error.
- A handshake result is committed only while its process is still current and the runtime has not
  failed/stopped; an exit or stream failure racing the `session/new` response fails the handshake
  instead of resurrecting the dead session as `ready`.
- Teardown sequence: stdin EOF → `stopGraceMs` → SIGTERM (Windows: `taskkill /T`) →
  `killGraceMs` → SIGKILL (Windows: `taskkill /T /F`).
- Frame observer (`onFrame`): raw NDJSON lines per direction in wire order; lines over 16 KiB are
  truncated with a marker; observer exceptions are swallowed.

## Dev-only visibility (stabilization gate)

Until the feature is stabilized, ACP agents are visible only in local development runtimes:
`platform.isLocalDevelopmentRuntime === true` (desktop dev; packaged apps are excluded) or
`import.meta.env.DEV === true` (web dev server). The gate hides the whole surface, not just the
entry point:

- Settings → Model Providers does not render the ACP agents panel (detection, enable, edit, login,
  test).
- `acp:<agentId>` personal providers are filtered out of the view `useModelProviders` derives from
  the provider settings service, so an agent enabled in development does not leak into provider
  navigation, detail pages, or settings lists in packaged and production builds.
- The provider host applies the same gate (`isEffectiveDevelopmentNodeEnv`, the signal that sets
  `acpExecutable`): in a packaged host the sidecar is not derived into providers, no ACP writer is wired,
  and `saveAcpAgent` / `setAcpAgentEnabled` fail with "not supported in this environment". The inline
  migration also does not run there.
- Existing sidecar and inline files stay on disk untouched. The gate never migrates, rewrites or
  deletes them; a development host keeps resolving them as before.

The host enforces the same gate: the settings bridge (detect / test / status / login) is wired
into the provider runtime only when the host runs as a development runtime
(`ZCODE_RUNTIME_ENV=development`, which desktop main injects for unpackaged builds). Elsewhere the
provider settings service answers `supported: false` / an error without spawning anything, so a
packaged host never spawns caller-supplied commands even if a client calls the RPC directly. A web
dev server started without `ZCODE_RUNTIME_ENV=development` therefore shows the panel as
unsupported.

Gate source (one signal for renderer and host): Electron main computes `isLocalDevelopmentRuntime =
!app.isPackaged` once (`desktopRuntimeEnv.ts`). Main passes it to every app renderer window as the
preload argument `--zcode-local-development-runtime`; preload exposes it before the renderer boots,
and the desktop platform reports it as `platform.isLocalDevelopmentRuntime`. The same value selects
`ZCODE_RUNTIME_ENV=development` for the host. A packaged app therefore keeps both the renderer
surface and the host bridge closed, and an unpackaged build — including a production-mode Vite
build such as the desktop E2E app — opens both. The renderer never derives this gate from a
compile-time `define`: Vite only applies `globalThis.<define>` under `vite dev`. The user-action
trace `deploymentEnvironment` keeps its own compile-time input and is not part of this gate.

E2E detection seam: `ZCODE_E2E_ACP_AGENT_PATH` replaces only the PATH that default detection
probes (every other detection input, and the env/args of spawned agents, are unchanged). The host
honors it only when the bridge is open (unpackaged, development runtime) and `ZCODE_ENV=test`;
anywhere else it is ignored. The desktop E2E points it at a run-scoped directory so detection
never sees a real `opencode` / `cursor-agent` installed on the machine.

The bridge still accepts `command` / `args` / `env` overrides (custom executables and the saved
provider's command), validated with the shared launch rules before anything is spawned or a login
script is written; resolving the command only from detection or the saved provider is a follow-up.

Remove this section together with the gate (`isLocalDevelopmentRuntime` in
`packages/ui/src/lib/devRuntime.ts` and the `useModelProviders` filter) when ACP ships publicly.

## Settings UI placement

ACP agents live inside the Model Providers master/detail layout, not as a separate card above it.

- Navigation: a dedicated group `id: "acp"` ("ACP agents") rendered directly after the `custom`
  group. Each installed agent, and each uninstalled agent that still has an ACP-managed provider, is
  one nav item (`type: "acpAgent"`, key `acp-agent:<agentId>`) with the agent initial, its name,
  and the status dot defined below. The group obeys the dev-only gate above.
- `acp:<agentId>` personal providers are listed only in the `acp` group, never also under
  `custom`.
- Detection has one owner: a single hook called once by `ModelProviderSection`; navigation and
  detail read its result. Rescan keeps the previous list visible while it runs.
- While the first detection is in flight the group shows a loading row, and navigation
  correction must not move an `acp-agent:*` selection away until detection settles.
- Empty state: when detection finds no installed agent the group still renders one entry
  ("Detect agents") whose detail lists the supported agents (name, installed badge, docs link)
  with a Rescan action. An agent that is not installed also shows the vendor's documented install
  command as selectable text (never executed by ZCode). A failed scan shows the error and Retry in
  that same detail. The Cursor installer links both `agent` and `cursor-agent`; detection keeps
  probing only `cursor-agent`, because a bare `agent` on PATH can belong to another CLI.
- Detail pane for an agent: header (initial mark, name, version, binary path, Rescan, enable
  switch labelled with the agent name, status), then sections for launch config (command, args,
  env), login/status helpers, and Test. Raw ACP frames are behind a collapsed disclosure. Unsaved
  form edits are dropped on navigation, the same as other provider details.
- Status (one rule for the navigation row and the detail header): `ready` when enabled, installed
  and not in conflict; `unavailable` when enabled but the CLI is not installed; otherwise `disabled`.
- Enable, edit and disable go through the dedicated settings-service methods `saveAcpAgent` and
  `setAcpAgentEnabled`, never the generic personal-provider mutations. Each is one atomic sidecar
  write, so there is no create-provider → add-model → best-effort-delete partial state.
- Switching off keeps the saved launch config (command, args, env): `setAcpAgentEnabled(false)`
  only flips the sidecar record's `enabled`. Removing the agent record entirely is out of scope
  for this section.
- ACP-managed providers (`acp:<agentId>` with the `acp-agent` access type) are excluded from the
  custom group and from the shared provider display order used by drag reorder. A same-id provider
  with another access type is a conflict and stays visible under custom.
- Detection requests carry a sequence number: only the newest response writes state, so an older
  scan that finishes later never overwrites a rescan. Detection runs once per mount; a rescan is an
  explicit action (page Refresh or the detail's Rescan).
- Selection: an `acp-agent:*` selection is not corrected while the first detection is pending. A
  selected catalog entry moves once to the first agent when one is found, without looping.
- Errors from enable, disable, test and scan are announced with `role="alert"`.
- Tests: effect-running jsdom tests cover one detection per mount, stale-response dropping,
  selection correction, the catalog-to-agent move, and a single login-status probe across rescans.
- Desktop E2E (`packages/desktop/test/e2e/settings/acp-agents-settings.test.ts`, mock agent via
  the detection seam): the group renders after Custom providers; the catalog empty state shows when
  nothing is detected, and Rescan moves to the detected agent; selecting an agent opens its detail;
  Test shows a roundtrip OK with a collapsed frames disclosure; the enable switch turns on then off
  and the saved command/args/env survive the off/on cycle in `fork_acp_agents.json` while the
  shared `provider_config.json` never holds an `acp:` provider; an enabled agent is not listed
  under Custom providers.

## Storage and upstream compatibility

The upstream app and this fork share `~/.zcode/v2/provider_config.json` (AGENTS.md "Shared
Databases and Fork Divergence"). Verdict for the original design, which stored the agent inline as
a personal provider with `access.type = "acp-agent"`: **unsafe**. Evidence, against the upstream
code pinned in `fork-upstream-base.json` (3.16.1, `0a1fc56d`):

- `providerAccessDataSchema` is a strict `z.discriminatedUnion("type", …)` over `api-key`,
  `zhipu-coding-plan-api-key` and `zhipu-account`. An `acp-agent` entry fails the parse; the
  decoder does not drop the entry, it throws for the whole file.
- The ACP pseudo-model writes `reasoningLevel.default`, a fork-only key that upstream's strict
  `enumOptionSpecDataSchema` also rejects. The derived pseudo-model keeps it in memory only; the
  personal rule writer strips it (`specs/fork-provider-config-upstream-compat.md`).
- Upstream `NodePersonalProviderConfigRepository.read()` catches the error and falls back to an
  in-memory empty overlay; the file is preserved, but the upstream build shows no personal
  providers and loses the configured `defaultModelSelection` (the headless CLI default). Its
  `update()` has no fallback, so every provider save in the upstream build throws, and upstream
  provisioning fails too.

Test: `packages/provider-node/test/acp-upstream-compat.test.ts` decodes fork-written files with
verbatim copies of the pinned upstream schemas (`test/fixtures/upstream-3.16.1/`).

Design (fix):

- Owner: `NodeForkAcpAgentStore` (`@zcode/provider-node`) persists the agents in the fork-owned
  sidecar `fork_acp_agents.json` next to `provider_config.json` (same directory, own file lock,
  atomic private write, 1 s polling like the personal repository). Record:
  `{ agentId, providerName, enabled, command, args, env? }` under `{ schemaVersion: 1, agents }`.
  An unreadable sidecar is preserved and read as empty; writes then fail until it is repaired.
- Invariant: `provider_config.json` never contains an `acp:` provider rule, model rule or
  `providerOrder` entry written by this feature. The upstream repository, codec and schemas stay
  untouched.
- Read path: the registry config source is decorated (`createDerivedAcpAgentConfigSource`,
  `@zcode/provider`), the same pattern as the derived ChatGPT plan providers. Each sidecar record
  becomes a personal provider rule `acp:<agentId>` with the `acp-agent` access and personal model
  id `agentId`, plus the synthetic model rule (`buildAcpPseudoModelConfig`). The snapshot's
  top-level `revision` gains an `#acp:<sidecar revision>` suffix; `personalRevision` stays the raw
  file revision because personal-model CAS writes compare against it.
- Conflict: a real `provider_config.json` rule with the same id wins and the derived one is not
  added. If that rule has a non-ACP access, Settings shows the conflict and `saveAcpAgent` refuses.
  If it is an inline `acp-agent` rule (legacy data), the sidecar record replaces it.
- Migration (one-shot, idempotent, at provider runtime start, before the registry starts):
  inline `acp-agent` rules found in `provider_config.json` are copied into the sidecar (an existing
  sidecar record wins), then one `update()` strips the `acp:<agentId>` rules whose agent the
  sidecar now holds, with their model rules and `providerOrder` entries. An `acp-agent` rule the
  sidecar does not hold (non-`acp:` id, unparsable record, or added by another writer between the
  two writes) is never stripped; it is kept and reported with a warning. A crash between the two
  writes leaves both copies; the next start repeats the strip. Without anything to strip the file
  is not rewritten. Migration failure is logged and never blocks startup.
- Provisioning stays main-file only: ACP launch config is per host (command paths are host-local)
  and is not synced to remote environments.
- Wiring: the desktop/web host provider runtime. Process registries in CLI workers do not see ACP
  providers yet; phase 4 (chat delegation) must wire the same decorator there.
- `chatgpt-account` / `chatgpt-family` are not affected: they only appear in derived builtin
  entries and account snapshots, never in `provider_config.json`.

```
 Settings UI ──saveAcpAgent / setAcpAgentEnabled──▶ ProviderSettingsService
                                                       │ 1. validate launch rules
                                                       │ 2. conflict check (personal repo read)
                                                       ▼
                                      NodeForkAcpAgentStore.update  ──▶ fork_acp_agents.json
                                                       │ 3. emit change
                                                       ▼
 provider_config.json ─▶ ProviderConfigService ─▶ [ChatGPT wrapper] ─▶ ACP decorator ─▶ Registry
   (upstream-identical)                                       (adds acp:<id> rules)     │
                                                                                        ▼
                                                                         4. settings view refresh
```

## Event ordering (runtime → host)

- Handshake: `initialize` (protocol version checked) → `session/new` — before any prompt.
- `session/update` notifications are mapped to typed events and only for the current session id
  (`message_chunk`, `thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage`,
  `session_title`, `available_commands`); foreign session ids only increment an ignored counter.
- Exactly one terminal event per prompt that reached `prompting`: `stopped` (with the agent's
  `stopReason`) when the turn completes, otherwise `prompt_failed` (with the error message) when the
  prompt rejects — cancel escalation, process death, transport failure or `stop()`. Never both.
- `stalled` after `stallWarningMs` without inbound frames: any inbound frame data for the current
  process (an update, a permission request, an fs call, a response) resets the timer.
- `process_exit` on child exit.

## Acceptance scenarios (encoded by tests)

- Full prompt with every update kind; restart after death; die-mid rejection; handshake timeout.
- Cancel: settle; cancelled-before-waiter race; escalation → state `failed` → next prompt restarts.
- Frame observer: capture in both directions; truncation; observer isolation; oversized frame error.
- Permissions: allow / deny / cancel mapping; fs bridge read/write; env scrubbing including
  capability inheritance and the per-launch opt-out.
- Registry: detection, safe version probes, cache, login/status argument declarations; detection
  IO is asynchronous, concurrent detections share one in-flight run per cache key, a refresh during
  a run never caches the stale result, and the version probe gets the scrubbed child env.
- Lifecycle: `stop()` stays `stopped` across cleanup failure and restart attempts; a handshake
  failure keeps its error when cleanup also fails; one terminal event per prompt; pending asks
  cancelled on every teardown; stall timer reset by any inbound frame.
- Launch rules: CR/LF/NUL and loader env keys rejected by the runtime, the provider schema and the
  bridge; the login script contains no heredoc and a crafted command is rejected before any
  terminal opens.
- Storage: every fork-written `provider_config.json` passes the pinned upstream schemas (inline
  `acp-agent` and the pseudo-model's `reasoningLevel.default` are shown to fail them); the sidecar
  store persists, preserves an invalid file and rejects duplicate ids; migration moves inline
  providers out, is idempotent and keeps the sidecar record after a crash between its two
  writes; save/enable/disable round-trip through the settings service with no `acp` trace in the
  main file, an invalid launch or a taken id is refused before any write.
- Logging: spawn, exit, handshake and cleanup failures are logged through `createServiceLogger`
  with agent id, exit code/signal and error message only (never env, args, frames or stderr).
- Live (manual, macOS): enable both agents in Model Settings → Test green with raw frames → login
  status visible.

## Chat delegation (phase 4)

Status: slices S1 (gate, registry, composer), S2 (text chat turns), S3 (tool, plan and title
rendering), S4 (user-once permissions), S5 (session restore via `session/load`) and S6 (agent
configuration options) are specified here.

### Decisions

- A turn driver is selected by the model factory and runs inside the CLI worker. CommandInbox
  admission, persistence, projection, mobile replay and owner/lease stay unchanged.
- Today's path is `CommandInbox` → `commands/prompt-turn.ts` → core `executeTurnCommand` →
  `runRegularTurnLoop` → `ApiProviderModelRuntime.modelFactory`.
- `modelFactory` checks `provider.config.access.type === "acp-agent"` before the AI SDK adapter. It
  returns a marker `Model` that carries an `ExternalAgentTurnDriver`. The port
  (`ExternalAgentTurnDriver`, `isExternalAgentModel`) lives in `@zcode/contracts`. Core never
  imports `@zcode/acp-agent-runtime`; the composition root (bootstrap) is the only place that
  binds the driver to the runtime.
- The marker's `generateText` and `streamText` throw `ExternalAgentUnsupportedError`
  (`external_agent_unsupported`). Side callers that reach the ACP model therefore fail closed.
- `executeTurnCommand` runs `runExternalAgentTurn` in place of `runRegularTurnLoop` when the loop
  model is a marker. It skips the title sidecar, memory prefetch and extraction, compaction,
  microcompact, reminders and ZCode tools. It still runs user hooks, attachment resolution and
  the normal TurnStarted/user-message persistence.
- The driver sends only the latest real user input (text) plus the current turn's image
  attachments as ACP image content blocks. Both agents advertise `promptCapabilities.image`.
- Process owner: a worker-scoped `AcpSessionPool` (bootstrap) holds one `AcpSessionRuntime` per
  ZCode `sessionId`. It spawns on the first turn and reuses the runtime while the session is
  resident. The agent cwd is core `workingDirectory` (worktree-aware), never `workspaceIdentity`.
  Launch config (command, args, env) is re-read from `fork_acp_agents.json` on every turn. Env
  comes from the runtime's `buildChildEnv`.
- Side callers that call `generateText`/`streamText` directly are handled explicitly. They skip
  when the session model is an external agent, or they use a non-ACP model. They never use the
  ACP model. Files: `core/src/memory/memory-agent-loop.ts`, `core/src/memory/recall/selector.ts`,
  `core/src/runtime/methods/compact-summary-model-request.ts`, `core/src/runtime/methods/model.ts`,
  `core/src/runtime/methods/runtime-model.ts`, `core/src/runtime/methods/sample-model.ts`,
  `core/src/runtime/methods/target-completion-verification.ts`,
  `core/src/runtime/methods/title-generation-sidecar.ts`,
  `core/src/runtime/methods/workspace-generate-text.ts`, `core/src/runtime/off-peak/model-binding.ts`,
  `core/src/tool/handlers/read-session-context.ts`, `core/src/tool/handlers/webfetch-processing.ts`,
  `core/src/tool/handlers/websearch.ts`.
- Event mapping (runtime event → ZCode core event). No protocol schema change is expected.
  - `message_chunk` → streaming text delta, persisted as a `text` part on the assistant message.
  - `thought_chunk` → streaming reasoning delta, persisted as a `reasoning` part.
  - `stopped` → `TurnComplete`. `stopReason: cancelled` takes the existing cancel path.
  - `prompt_failed` and `process_exit` during a turn → `TurnError`. Auth failures carry an
    actionable message (`The external agent requires sign-in: run <agent> login in a terminal`).
  - `usage` → counted as external usage on the assistant step-finish and on `TurnComplete`
    (labelled as external, not billed to a ZCode provider).
  - `available_commands`, `stalled` → logs only. `session_title`, `tool_call*`, `plan` are S3/S4.
- Permissions in S2: the driver's permission handler logs the ask and answers `cancelled`. Asks are
  never surfaced and never implicitly allowed.
- Cancel: stop → existing `stopActiveForegroundExecution` → turn abort → driver `cancel()` →
  `runtime.cancel()` (bounded `session/cancel`). The turn completes as cancelled. An escalation kill
  marks the runtime `failed`, and the next turn restarts it through the runtime's own restart path.
- Dev-only gate: the S1 registry gate and the composer gate are the same dev-runtime signal as the
  host bridge (`isEffectiveDevelopmentNodeEnv`). Packaged builds never execute an `acp:` model.

### Product defaults (v1)

- Switching models is allowed. No transcript is seeded into the ACP agent; the ZCode transcript
  remains the ZCode record and is updated with the agent's assistant text.
- Permissions are user-once only (S4).
- Input is text and images.
- Blocked for subagents, automations, off-peak and bots. The enforcement point is
  `executeTurnCommand` for automation, off-peak and bot turns (refused before any model step), and
  the side-caller fail-closed marker for subagents. Tests cover both.
- The title comes from the agent's `session_title` (S3). Until then the ZCode title sidecar is
  skipped for external sessions.
- Agent slash commands are not exposed.
- Usage is counted and labelled external.
- Both opencode v2.0.31 and cursor-agent 2026.10.18 advertise `agentCapabilities.loadSession: true`.
  Session restore through `session/load` is S5.

### Owner and event order

Submit → admission → ACP prompt → updates → events → stopped:

```text
renderer submit
  │
  ▼
CommandInbox (owner: CLI runtime) ── admission, queue, owner/lease
  │
  ▼
executeTurnCommand ── TurnStarted + user message persisted (unchanged)
  │  loop model is marker?  yes ──▶ runExternalAgentTurn (replaces runRegularTurnLoop)
  ▼
ExternalAgentTurnDriver.runTurn(sessionId, prompt blocks, signal)
  │
  ▼
AcpSessionPool (owner: worker) ── acquire(sessionId): spawn + handshake on first turn
  │
  ▼
AcpSessionRuntime.prompt(blocks)     state: ready → prompting
  │  session/update message_chunk   ─▶ text delta (stream) ─▶ text part
  │  session/update thought_chunk   ─▶ reasoning delta     ─▶ reasoning part
  │  session/request_permission     ─▶ log, answer cancelled (S2 stub)
  │  session/update usage           ─▶ usage (external)
  ▼
stopped(stopReason) ─▶ step-finish + assistant completed ─▶ TurnComplete ─▶ projection
prompt_failed / process_exit ─▶ TurnError (auth message if auth)
```

Cancel:

```text
Stop ─▶ stopActiveForegroundExecution ─▶ turn abortSignal
  │
  ▼
driver.cancel() ─▶ runtime.cancel()  (session/cancel, bounded by cancelGraceMs)
  │  prompt settles, stopReason=cancelled ─▶ stopped ─▶ TurnCancelled (existing path)
  │  does not settle ─▶ escalate: process-tree kill ─▶ prompt_failed ─▶ runtime failed
  ▼
next turn: runtime.prompt() restarts the process and session (owner: runtime)
```

Permission stub (S2):

```text
agent ─▶ session/request_permission ─▶ runtime isLive check (prompting, same generation)
  ├ not live (stale/orphaned/foreign session) ─▶ cancelled, never surfaced
  └ live ─▶ driver permission handler: log "permission cancelled (S2)" ─▶ cancelled
```

### Implementation notes (S2 as shipped)

- Registry admission: an executable ACP provider enters the execution Registry only behind the
  development gate (`acpExecutable`). Its registry config is validated by the ACP schema (not the
  API-key union). The model-selection projection drops `env` (it may carry credentials).
- Composer: an agent provider has no `api` section, so the composer's registry grouping
  (`buildRegistryModelSelectGroups`) admits `access.type = "acp-agent"` explicitly. The development
  gate in the Registry still decides whether the group exists at all.
- Dependency: `@agentclientprotocol/sdk` resolves its `zod` peer from `acp-agent-runtime`, which pins
  `zod` 4.6.5 like `services`; without the pin the desktop build's zod dedupe check fails.
- Side callers: title, memory recall/extraction and the MCP-prefetch are skipped for external turns.
  Every other direct `generateText`/`streamText` call site fails closed through
  `assertNotExternalAgentModel(model, caller)`, which names the caller in the error. Wrappers forward
  to the guarded marker.
- Refusals (automation, off-peak, bot, background results, runtime continuations, `/compact`,
  `/dream`) are recorded as the existing model-creation failure, so the accepted input persists and
  the user gets a TurnError with the refusal message. Subagents are refused in the child model
  factory, because an inherited selection can carry the parent's ACP model.
- Usage: an external turn has no `ModelComplete` events. Its usage is reported on `TurnComplete` with
  `usage.source = "external-agent"`; the assistant step is attributed to the `acp:<agentId>` provider.
- Turn driver: the composition root (bootstrap) owns `AcpSessionPool` (one runtime per session,
  restart on failure, replacement on a launch change, stop on app close and worker shutdown) and the
  per-turn driver, which re-reads the sidecar record on every turn.
- Architecture: the `apps/zcode-cli` tree has no managed module yet. The new ACP files are listed under
  `exceptions` in `architecture-policy.yaml` with the same reasoning as the ACP sidecar exception.
- Not covered in S2: `available_commands` and `stalled` events are ignored (not logged); the subagent
  refusal has no dedicated unit test; S3–S5 are unchanged.

### S3: tool, plan and title events

Runtime event → ZCode mapping. The driver turns ACP updates into turn events; core owns every
ZCode event and persisted part. ACP-origin rows are never a tool contract for the model.

| ACP update           | ZCode effect                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool_call`          | `ToolCallScheduled` (toolName `acp:<kind>`, `kind` absent → `acp:other`, input = `rawInput` or `{}`) and a persisted `tool` part (`pending`). When `status` is `in_progress`, also `ToolCallStarted` and the part becomes `running`. |
| `tool_call_update`   | First `in_progress` → `ToolCallStarted`. `pending`/`in_progress` → `ToolCallProgress`. `completed` → `ToolCallResult` (output = text content). `failed` → `ToolCallError`. An unseen id creates the row on the fly.                  |
| `plan`               | A synthetic `TodoWrite` row (scheduled, started, result) with input `{todos}`. The session todo state is written with `updateTodos`, so the todo panel follows the plan.                                                             |
| `session_title`      | `SessionTitleUpdated` with `source: "generated"` through the existing title setter. A `custom` title is never overwritten. An unchanged title is skipped.                                                                            |
| `available_commands` | Debug log only.                                                                                                                                                                                                                      |
| `stalled`            | Warn log only.                                                                                                                                                                                                                       |

Rules:

- Ordering. Text and reasoning deltas stream through the segment queue. Before a tool or plan event,
  core closes the open text/reasoning block, drains the queue and persists the segment. The next
  text opens a new part, so cold hydration keeps the reply order. Every `onEvent` runs on one
  promise chain, and the turn awaits the chain before it finishes or fails.
- ZCode tool call ids are minted per turn, one per ACP `toolCallId`. The first `tool_call` or
  update carrying an id creates the row. A missing or empty title is absent, and an update merges
  into the row.
- Output text is capped at 32 KiB before it is persisted or streamed.
- Turn end. Every row that is still open is closed as `ToolCallError`: "Cancelled" for a cancelled
  turn, otherwise "The agent turn ended before this tool finished".
- Tool parts carry `metadata.externalAgent = true`. Cold history hydration skips them, so a later
  non-ACP model never sees an `acp:*` tool call without a declared tool.
- Logs: `available_commands` (debug) and `stalled` (warn) carry the agent id and counts only.

Acceptance (S3):

- A `tool_call` with `in_progress` emits Scheduled then Started. A completed update emits Result
  with the text output. A failed update emits Error.
- A `tool_call_update` for an unseen id creates one row. Text before and after a tool is persisted as
  two text parts in order.
- A plan emits a `TodoWrite` row and writes the session todos.
- A title event updates the session title. A custom title is kept.
- Cancel or failure while a tool is open closes the row with an error.
- The E2E scenarios for the tool row, the plan and the title are in the desktop conversation spec.

### S4: user-once permissions

An agent's `session/request_permission` becomes a ZCode permission prompt. The prompt is the existing
user-once dialog (Allow once / Deny). Nothing else answers it.

Path and owners:

```text
agent ─▶ session/request_permission
  │ runtime live check (prompting, same generation, same session)   ─ not live ─▶ cancelled (never surfaced)
  ▼
driver (bootstrap) ─ routes to the turn bound to this session (pool) ─ no bound turn ─▶ cancelled
  ▼
core turn ─ answerExternalAgentPermission
  │ ToolCallScheduled row for the ACP id exists (created on demand)
  │ permissionBroker.requestPermission({approvalMode:"user-once", toolName:"acp:<kind>", signal})
  │ await registered ─▶ PermissionRequested (requestId, toolCallId, approvalMode user-once)
  │ await the user's answer, or the turn abort
  ▼
PermissionResolved (exactly once) ─▶ allow → selected allow_once | deny/abort → reject_once | cancelled
```

Rules:

- The ZCode permission service (`PermissionService.checkPermission`) is not consulted, so no ZCode
  mode (`yolo`, `guarded`, `plan`, `auto`, `edit`, `build`) answers an ACP ask. The broker is
  called for every ask. The request carries `mode: "guarded"` because an ACP ask always needs the
  user. Hooks and fullAccess are off (`user-once`).
- Answers map by `kind` only. `allow` → `allow_once`, `deny` → `reject_once`. `allow_always` is never
  sent. `permissionUpdates` and session grants are ignored, so no project rule or session rule is
  written (`bootstrap/src/permission-options.ts` is not used for ACP asks).
- Event order per ask: the scheduled tool row, then `PermissionRequested` after the broker registers
  the interaction, then exactly one `PermissionResolved`. A deny carries the user's reason; an abort
  resolves as deny with reason "Permission request cancelled". An ask that the turn aborts before it
  starts publishes nothing: the user never saw it.
- An ask is handled after the events the agent sent before it, so its tool row already carries the
  kind the agent reported.
- Turn cancel or abort: pending asks are answered `cancelled`. The runtime `cancel()` answers every
  pending ask `cancelled` before it sends `session/cancel`, because ACP requires the client to answer
  before the turn can stop. The core waits for the pending `PermissionResolved` before it writes
  `TurnCancelled`, so the replay never shows a dialog for a finished turn.
- Stream semantics. `PermissionRequested` and `PermissionResolved` are persisted session events. The
  desktop-continuous link receives them live, and the web-remote-replayable link rebuilds the pending
  interaction from the same log after a reconnect. Neither link has a separate ACP path.

Acceptance (S4):

- Allow: the agent receives `allow_once` and the turn continues; one `PermissionResolved` (allow).
- Deny: the agent receives `reject_once`; the turn continues and the tool row ends as rejected.
- Cancel during a pending ask: `cancelled` reaches the agent, one `PermissionResolved` (deny), then
  the turn ends as cancelled.
- A yolo, plan or auto session still shows the prompt for an ACP ask.
- A runtime that asks while no turn is bound answers `cancelled` and never calls the broker.
- The runtime `cancel()` answers pending asks `cancelled` before `session/cancel`.

### S5: session restore through session/load

Both opencode v2.0.31 and cursor-agent 2026.10.18 advertise `agentCapabilities.loadSession: true`.
The runtime restores an earlier ACP session instead of starting over when that is possible.

Binding and owners:

- `fork_acp_session_binding` (migration `9003_fork_session_acp_binding`, the fork's `fork_` prefix) holds
  one row per ZCode session: `agent_id`, `acp_session_id`, `cwd` and `launch_key`, a SHA-256 digest of
  the launch config (the env can carry credentials, so the config itself is never stored). The table
  is separate from upstream session rows and needs no upstream column change.
- The pool owns the binding. After every acquire (a new runtime, a reused runtime, or a restart) it
  writes the binding of the session the runtime now holds.
- A cold start (no resident runtime) resumes the stored `acp_session_id` only when the agent, the
  working directory and the launch digest all match. Any other binding is cleared, so the agent starts
  a new session.
- A launch-config change replaces the runtime and clears the binding. An agent switch clears it too.
  Deactivation (`stopSession`) keeps the binding, so the next turn is a cold start.
- The runtime remembers the session id it last established. A restart after a failure asks for that
  session again.

Handshake (`performAcpHandshake`):

```text
initialize (protocolVersion)
  ├ resume target and agentCapabilities.loadSession ─▶ session/load(sessionId, cwd)
  │    ├ ok ─▶ start = loaded  (the replayed history updates are foreign to the uncommitted session: counted, not surfaced)
  │    └ error (refused, timed out, or a process failure) ─▶ fall through
  └ session/new(cwd) ─▶ start = created (no earlier session) | reset (earlier session not restored)
```

Visible reset: a `reset` start emits one `context_reset` turn event before the agent's first output.
Core persists a `SystemMessage` of type `external_agent_context_reset` (content: the agent id), and the
v4 projection shows it as the `agentContextReset` divider in the timeline. A cold replay keeps the
event, because it is not a transcript-derived type. No notice appears for `loaded` or `created`.

Acceptance (S5):

- The binding round-trips and is replaced per session (adapter test on the migrated database).
- A matching stored binding resumes; a changed agent, cwd or launch digest starts a new session and
  clears the binding; without a binding store nothing resumes and nothing is written.
- With `loadSession` true the handshake sends `session/load`, not `session/new`, and the replayed
  history is not surfaced. With `loadSession` false, or a refused load, the handshake sends
  `session/new` and reports `reset`.
- A runtime that dies after a turn loads the same session on its next prompt.
- E2E: after an app relaunch, the next turn loads the earlier session (`session/load`, no
  `session/new` in the relaunched process), the mock recalls the word from the first turn, and the
  replayed text is not shown.

### S6: agent configuration options

ZCode's permission modes do not control an external agent. The agent applies edits itself, ignores the
client `fs.writeTextFile` capability, and asks only for shell commands outside its own allowlist. The
control surface is the agent's own session configuration, so the composer shows the agent's selects
instead of the ZCode permission modes when the selected model is an ACP agent.

Sources of the options:

- `session/new` and `session/load` responses carry `configOptions` (ACP `SessionConfigOption`) and,
  for some agents, the legacy `modes` (`currentModeId`, `availableModes`). `configOptions` wins. The
  legacy `modes` are used only when `configOptions` is absent or empty, and then `mode` is a synthesized
  select with the agent's mode ids. A synthesized `mode` is set with `session/set_mode`.
- Only select options are offered. Boolean options are dropped with a debug log (no current agent
  advertises one). Groups are kept on each option and flattened when a value is validated.
- Ownership of each fact:

| Fact                                          | Owner                                           | Persisted in                                             |
| --------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| Offered options and the agent's current value | AcpSessionRuntime snapshot (handshake, updates) | `fork_acp_session_binding.config_options` (display copy) |
| Chosen values (user choices)                  | ZCode session (driver reconcile)                | `fork_acp_session_binding.config_choices` (JSON map)     |
| Projected options for the composer            | Session config state (projection)               | `external_agent_config_updated` session event            |

Chosen values are cleared with the binding: an agent switch, a cwd change or a launch-config change
clears them, because the values belong to one agent process configuration.

Decision: the controls are disabled with "available after the first message" until the session has an
offered snapshot. The alternative (the worker spawns the agent when the agent is selected) was rejected:
a composer selection would start an agent process outside CommandInbox admission and outside the owner
and lease of a turn, and a draft may have no session yet. After the first turn, the snapshot is
persisted and projected, so the controls are available again after an app relaunch without a spawn.

Runtime (`packages/acp-agent-runtime`):

- `configOptions` getter: the normalized snapshot (`AcpConfigOption`: id, name, description, category,
  currentValue, options). It is updated by the handshake, `config_option_update`, `current_mode_update`
  and the `setConfigOption` response.
- `setConfigOption(configId, value)` sends `session/set_config_option` (`sessionId`, `configId`,
  `value`) and returns the snapshot. It requires state `ready`. A synthesized `mode` sends
  `session/set_mode` (`modeId`) instead. An unknown id or a value outside the options rejects before any
  request.
- Events: `config_options` (the full snapshot after a `config_option_update` or
  `current_mode_update`) and `resumed` (first inbound frame after `stalled`).

Turn reconcile (driver, before `runtime.prompt`):

```text
pool.acquire(sessionId)  ─▶ runtime (fresh, reused, or restarted; loaded or new session)
  │
  ▼ read choices (config_choices) and offered options (runtime.configOptions)
  ├ choice id not offered, or value not in the options ─▶ drop, debug log (no request)
  ├ choice differs from the agent's current value    ─▶ setConfigOption; failure ─▶ TurnError
  ▼
offered snapshot differs from config_options ─▶ persist it, emit external_agent_config_updated
  ▼
runtime.prompt(...)
```

- A change made while a turn runs (command handler) persists the choice and never touches the
  runtime. It applies at the next reconcile, before the next prompt. The turn is not interrupted.
- `config_options` events during a turn (agent-initiated changes) update the display copy. They do not
  overlay the user's choice, so the composer shows the agent's real value until the next reconcile.

Stop during the spawn or the reconcile: the driver checks the turn signal after the launch read, after
`pool.acquire`, after the reconcile, and after the permission bind (the last check before `session/prompt`).
Each check that finds the signal aborted returns `cancelled` with no prompt. A runtime that finished its spawn
stays resident for the next turn. Core treats the returned `cancelled` as a Stop, not as a failure.

Binding failures are not turn failures. A failed binding read starts a new agent session, and a failed binding
write leaves the runtime resident. Both are logged as warnings that name the lost resume, so a write error is
never reported as a start failure.

Seed and cache: the projection seed reads the binding only for a session whose projected provider is an
`acp:` provider (`ACP_PROVIDER_ID_PREFIX`). The binding store keeps the last config read per session (bounded,
dropped by every write of the store), so a repeated subscribe does not reopen the shared session database.

The cache assumes one live worker per session. A session has one owner (owner/lease, see "Owner and event
order"), so the worker that owns it is the only writer of its binding row, and the cache of that worker's
store instance cannot go stale. A second worker writing the same row would break this, so the cache must not be
shared across processes. A failed binding write clears the row (best effort) so no later cold start loads the
session the row named.

Permission publication (S4 refinement): an ask is suppressed only when the turn aborts before the broker
registers it. An ask the broker registered is published as requested, even when the abort lands right after,
and is then resolved cancelled, because the client may already show the dialog.

Command `setExternalAgentConfigOption { sessionId, configId, value }` (worker, owner: session):

- Refused with `config.notAvailable` when the session has no `config_options` snapshot ("available
  after the first message"), and with `config.invalid` when the id or value is not offered.
- A same value that is already the chosen value and the shown value is a no-op (`config.unchanged`).
  Choosing the shown value when it is not the stored choice (an agent-initiated value) stores it, so
  the next reconcile does not revert it.
- The command carries no `baseRevision`: the choice does not depend on the conversation revision.
  The payload `sessionId` must equal the envelope's session (`config.invalid` otherwise). A session
  whose model is not `acp:<agentId>` is refused with `config.notExternalAgent`; refusals are failed
  ACKs with the reason code.
- Otherwise it writes `config_choices`, writes the display copy with the chosen value, and emits
  `external_agent_config_updated`. The command is additive on the v4 protocol. It is declared in the v4
  command union (`packages/shared/src/zcode-protocol-v4/command.ts`) with a strict zod payload and runtime
  validation, the same place as the other v4-only commands (`createSelectionSideSession`,
  `updateWorktreePreparation`). The legacy `zcode-protocol/index.ts` has no route for a v4-only command and is
  not changed. A v4 command that has a legacy twin (`switchCollaborationMode`) is declared in both.

Event and stream semantics: `external_agent_config_updated` is a persisted session event. The
desktop-continuous link receives it live, and the web-remote-replayable link rebuilds the selects from
the same log after a reconnect. Cold replay keeps it (it is not transcript-derived). The share projection
passes it through without rendering a row. The projected field is `config.externalAgentConfig`
(`{ agentId, options }`). Session events live in the worker's memory, so after a worker restart the
gateway seeds `config.externalAgentConfig` from `fork_acp_session_binding.config_options` when the
projection is hydrated (no delta; an event value always wins over the seed).

Stall: the runtime emits `stalled` once per prompt after `stallWarningMs` without frames, and `resumed`
on the next inbound frame. The driver forwards both to core. Core shows a non-blocking turn status
"The agent is not responding…" with Stop available, and clears it on `resumed` or at turn end. No
transcript row is written. Core appends `external_agent_status` (`{ agentId, status, silentMs? }`); the
projection sets `control.externalAgentStall` (`{ agentId, since, silentMs }`, nullable, optional) for the
running turn and sets it to `null` on `resumed`, `TurnStarted`, `TurnComplete` and `TurnError`. The
existing `control.apiRetry` is not reused: it carries attempt counts and renders as "Reconnecting…".
Cold replay drops the status of a settled turn.

UI (as shipped, `packages/ui`):

- Owner: the projection (`config.externalAgentConfig`) is the only source of the shown values. The
  renderer keeps no optimistic copy; a choice is shown after `external_agent_config_updated` arrives.
- The composer shows the agent controls instead of `V4ComposerModeSwitch` when the draft's
  `modelSelection.providerId` is `acp:<agentId>` (`V4ExternalAgentConfigControls.tsx`, branch in
  `V4ComposerModeArea`). The ZCode model picker stays. Non-ACP models render the ZCode mode switch
  unchanged.
- Controls: Mode (`category: "mode"` or id `mode`), Model (`category: "model"` or id `model`) and Effort
  (`category: "thought_level"` or id `effort`, only when offered). Other options are not shown. Labels,
  value names and descriptions come from the agent and are not translated.
- Enabled only when the session exists, the projection is present, its `agentId` equals the draft's
  agent, and the session's own model (`config.modelSelection.providerId`) is that `acp:` id. Otherwise
  Mode and Model render disabled (`aria-disabled`, the menu still opens) with
  `chat.toolbar.externalAgent.availableAfterFirstMessage` ("Available after the first message").
- Every agent menu shows the hint `chat.toolbar.externalAgent.hint` (the agent applies its own edits;
  shell commands outside its allowlist ask for permission).
- Search: a select with more than 8 values gets a filter input
  (`chat.toolbar.externalAgent.searchPlaceholder`); matching is case-insensitive on the value name.
- Selecting a value sends `setExternalAgentConfigOption` through the session pane's `dispatchCommand`
  (`sendExternalAgentConfigOption`). `noop` is silent; a failed ACK shows a toast mapped from the reason
  code (`chat.toolbar.externalAgent.error.notAvailable|invalid|notExternalAgent|failed`); a transport
  error shows the generic failure toast.
- Shortcut decision: `cycleSessionMode` (Ctrl+Shift+M) cycles the agent's mode option in its value order
  and sends the next value while the controls are enabled; it does nothing while they are disabled.
  `cycleThoughtLevel` is not bound to the agent's Effort (the ZCode toolbar keeps that binding).
- Stall: `control.externalAgentStall` renders in the running turn's loading slot (`TurnChatLoadingSlot`,
  the slot that shows the apiRetry "Reconnecting…" status) as `chat.externalAgent.stalled` ("The agent is
  not responding…"). Precedence: stall, then apiRetry, then the loading indicator. It follows the same
  gate as the loading indicator: hidden while an interaction (for example a permission card) owns the
  turn's progress. Only the live turn receives it; history turns get `null`. The composer Stop control
  is unchanged.

Migration `9004_fork_session_acp_config` (additive, `fork_` prefix) adds nullable `config_options` and
`config_choices` (text) to `fork_acp_session_binding`. Upstream migrations are unchanged.

Acceptance (S6):

- Runtime: `configOptions` from `session/new` and `session/load`; legacy `modes` maps to a `mode` select
  only when `configOptions` is absent; `setConfigOption` sends `session/set_config_option` and returns
  the snapshot; the legacy path sends `session/set_mode`; `config_option_update` and
  `current_mode_update` update the snapshot and emit `config_options`; an unknown value rejects without
  a request.
- Worker: a stored choice is re-applied after a cold start and after a restart; a choice the agent no
  longer offers is dropped (debug log, no request); a change during a running turn is applied before the
  next prompt and does not interrupt it.
- Migration: `9004` adds both columns on a database that already has `9003`, and an upstream migration
  checksum is unchanged.
- UI: an ACP model shows the agent's selects (mode, model, effort if offered) and no ZCode permission
  modes; a non-ACP model is unchanged; labels come from the agent; the hint about the agent applying
  edits and asking for commands outside its allowlist is visible.
- E2E (`conversation-session-acp-agent-config.test.ts`): select the agent mode "plan" after a first
  turn, send, and the mock records `session/set_config_option` (mode=plan) before `session/prompt`; the
  value survives an app restart.

### Reservation ordering (first message)

The composer binds the pane to the reserved session id before the host acknowledges the `createSession`
(display only). The conversation lease for that id is the owner of the subscribe, and it opens only after
the create is acknowledged: `pendingReservations` (`SessionPane.tsx`, backed by `pendingReservationGate.ts`)
marks a create from the moment it is sent until its ack. This follows the order of every later turn, where
the subscribe comes after the acknowledgement.

The reservation envelope carries the id in the payload and dispatches with a null envelope target
(`createCommandEnvelope` copies the dispatch target). The renderer marks the id from the payload
(`reservedCreateSessionId`), and the inbox keys the create on the payload id, falling back to the envelope
target. Both sides read the same field.

The host keeps a second guard. `CommandInbox.whenSessionCreationSettles` (tracked from receipt in
`command-inbox-creations.ts`) makes a subscribe that reaches the gateway while the create is admitted wait
for it. Before these guards, a subscribe sent during the create was answered `fault.subscribe.sessionNotFound`,
which the renderer treats as terminal. The rule is not ACP-specific and applies to every first message.

### Acceptance scenarios

- Marker model: `generateText`/`streamText` throw `external_agent_unsupported`; the factory returns
  a marker only for an `acp-agent` provider.
- A turn with a fake driver emits text and reasoning deltas in order, then exactly one terminal
  event (TurnComplete or TurnError), and TurnComplete carries external usage.
- Cancel during a hung prompt ends the turn as cancelled and leaves the runtime reusable or
  restarted by the next turn.
- Side callers never reach the ACP model (each returns its skip result).
- Automation, off-peak and bot turns with an ACP model are refused before the first model step.
- Pool: the second turn reuses the process; deactivation stops the runtime; a failed runtime is
  restarted on the next turn; worker shutdown stops every runtime.
- Resolver: `acpExecutable: false` keeps the ACP model non-executable and out of the composer;
  `acpExecutable: true` makes it executable.
- Desktop E2E (`conversation-session/conversation-session-acp-agent-text.test.ts`): enable the mock
  agent, select it, send and see "pong" stream to completion; stop during a hang ends as cancelled;
  a second turn reuses the process.

## Upstream compatibility of persisted chat events

Scope: every ACP chat shape the fork writes into the databases the upstream build also opens
(`~/.zcode/cli/db/db.sqlite` sessions and `~/.zcode/v2/tasks-index.sqlite`). The pin is
`fork-upstream-base.json` (3.16.1, `0a1fc56d`); all `file:line` references below are at that pin unless
marked "fork". Upstream's `SessionEventStorePort` is in memory (`server.ts:289`, `create-app.ts:841`), so an
upstream build reads only the durable rows: `session`, `message`, `part`, `session_entry`, the usage tables,
`tool_usage`, and the tasks index. Events reach upstream only when a hydration pass rebuilds them from those rows.

Evidence: `apps/zcode-cli/packages/bootstrap/tests/acp-upstream-compat.test.ts` runs a scripted ACP turn on a
real SQLite store, then decodes the rows with verbatim upstream copies in
`tests/fixtures/upstream-0a1fc56d/` (`decodeStoredMessage`, `decodeStoredPart`, `decodeStoredSessionModelSelection`,
`decodeSessionTitleSource`, `decodeSessionTaskType`, `shouldHideInvalidToolCallFromProduct`, and the
`modelSelectionSchema`). The remaining verdicts are from code reading.

### Verdicts

| Shape                                                                                 | Where the fork writes it                                                                                                                                     | Upstream read at the pin                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExternalAgentConfigUpdated`, `ExternalAgentStatus`                                   | nowhere durable; `appendEvent` to the in-memory store only (fork `external-agent-session-events.ts`; `events.ts` `persistDurableSessionEvent` has no branch) | never read                                                                                                                                                                                                                                                                                                                                                                                                                                         | SAFE                                                                                                                                                                                                            |
| `SystemMessage` `external_agent_context_reset`                                        | same, memory only (fork `external-agent-turn.ts:273-284`)                                                                                                    | never read                                                                                                                                                                                                                                                                                                                                                                                                                                         | SAFE                                                                                                                                                                                                            |
| `ToolCallScheduled.title`                                                             | memory event; the tool part keeps `state.title` as all tools do                                                                                              | upstream `ToolState.title` already exists                                                                                                                                                                                                                                                                                                                                                                                                          | SAFE                                                                                                                                                                                                            |
| usage `source: "external-agent"`                                                      | not in `turn_usage` or `model_usage` (no source column); `TurnComplete` only sets `lastOutcome`                                                              | never read                                                                                                                                                                                                                                                                                                                                                                                                                                         | SAFE                                                                                                                                                                                                            |
| `metadata.externalAgent` on tool parts                                                | `part.data`                                                                                                                                                  | `decodeStoredPart` passes through (`codecs.ts:126-150`). `parseCompletedToolPartMetadata` returns `undefined` without `schemaVersion` (`tool-result-metadata.ts:349, 357`), which drops nothing because ACP writes no `display`. The v3 mapper passes `metadata` through (`zcode-protocol/message-mapper.ts:90-96, 282-290`).                                                                                                                      | SAFE                                                                                                                                                                                                            |
| tool name `acp:<kind>`                                                                | `part.tool`, `tool_usage.tool_name` (fork `external-agent-tool-rows.ts`)                                                                                     | not filtered: `shouldHideInvalidToolCallFromProduct` only hides empty names (`tool-call-product-visibility.ts:8-13`). Cold synthesis passes the name on (`transcript-hydration.ts:770-782`). `onToolCallScheduled` builds a generic row (`product-projection.ts:3119, 3161-3168`). Usage groups by name as text (`usage.ts:461`). Transcript and search pass it through (`session-transcript.ts:177`, `core/session-context/parts.ts:24, 91-103`). | DEGRADED. The upstream row shows the raw name `acp:read` and the input JSON, not the agent's title. The agent title reaches cold replay only as the part's `state.title`, which the row does not use. No crash. |
| `modelSelection {providerId: "acp:<id>"}` on user rows, and the legacy `model` object | `message.data` (`adapters/.../repositories/messages.ts:45-60`)                                                                                               | `decodeStoredMessage` keeps a valid selection. `modelSelectionSchema` accepts any non-empty `providerId` (`packages/shared/src/model-selection.ts:3-15`). Tested.                                                                                                                                                                                                                                                                                  | SAFE for decoding (see the next row for send)                                                                                                                                                                   |
| `runtime/model_selection` session entry                                               | `session_entry.data`                                                                                                                                         | `decodeStoredSessionModelSelection` keeps it (`codecs.ts:177-182`). Tested.                                                                                                                                                                                                                                                                                                                                                                        | SAFE for decoding                                                                                                                                                                                               |
| assistant `providerId: "acp:<id>"`, `modelId`                                         | `message.data` (`message-persistence.ts:276-330`)                                                                                                            | Cold hydration synthesises a `ModelSelected` from it (`transcript-hydration.ts:1127-1138, 1684-1693`). `onModelSelected` (`product-projection.ts:4730`) copies the selection into the projection.                                                                                                                                                                                                                                                  | DEGRADED (display only; no crash)                                                                                                                                                                               |
| sending in a resumed ACP session                                                      | n/a                                                                                                                                                          | On resume, upstream derives no registry selection (`app/runtime-config.ts:223` for a stored selection that fails validation, and `:233` otherwise). A turn then goes through `ApiProviderModelRuntime.modelFactory`, which throws `Provider Registry 中不存在 Provider` (`provider-registry-selection.ts:119-125`). Upstream has no `acp:` providers in its registry. Not executed; the composer path is assumed.                                  | DEGRADED. The session opens and shows history. The next send fails until the user picks a model.                                                                                                                |
| `title` set by the agent; `title_source = "generated"`                                | `session` row (`updateSession` in `session-title.ts`)                                                                                                        | `decodeSessionRow` (`codecs.ts:51-82`) and `decodeSessionTitleSource` (`codecs.ts:45-49`) accept `generated` (`session-store.port.ts:45`). Tested.                                                                                                                                                                                                                                                                                                 | SAFE                                                                                                                                                                                                            |
| `task_type = "interactive"`                                                           | `session` row                                                                                                                                                | in `SESSION_TASK_TYPES` (`session-store.port.ts:34-42`). Tested.                                                                                                                                                                                                                                                                                                                                                                                   | SAFE                                                                                                                                                                                                            |
| `fork_acp_session_binding`, migrations 9003 and 9004                                  | fork table with no foreign key (`fork-migrations.ts:38-45`)                                                                                                  | The upstream runner reads the ledger only by its own ids (`packages/shared/src/sqlite-migrations/runner.ts:66-70`), so unknown rows are ignored. Upstream never queries the table. With `foreign_keys = on` (`migration-runner.ts:89`) a session delete still succeeds. Tested.                                                                                                                                                                    | SAFE                                                                                                                                                                                                            |
| session event-store contents and the events-only `external_agent_*` names             | no durable table                                                                                                                                             | Tested: the strings appear in no row                                                                                                                                                                                                                                                                                                                                                                                                               | SAFE                                                                                                                                                                                                            |

No shape BREAKS. The DEGRADED rows need no fork change. Two follow-ups are possible but not needed for
compatibility: a friendly tool label could be stored in a fork column, and the resumed-send case could get a
fork-side selection fallback. Both are product decisions, so they are not implemented here.

The provider and agent configuration (`provider_config.json`, and the fork sidecar `fork_acp_agents.json`)
is covered by `packages/provider-node/test/acp-upstream-compat.test.ts` and by the section above
"Storage and upstream compatibility".

### Refreshing the fixture

When `fork-upstream-base.json` moves, re-copy the bodies named in `tests/fixtures/upstream-0a1fc56d/` from the
new pin, update the commit in the directory name and the header comments, and rerun the test.
