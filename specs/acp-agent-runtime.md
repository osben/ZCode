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
  loader keys; values are at most 8192 characters without NUL. A stored provider that violates the
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
- Existing configs stay on disk and keep resolving; the gate hides UI, it never migrates or deletes.

The host enforces the same gate: the settings bridge (detect / test / status / login) is wired
into the provider runtime only when the host runs as a development runtime
(`ZCODE_RUNTIME_ENV=development`, which desktop main injects for unpackaged builds). Elsewhere the
provider settings service answers `supported: false` / an error without spawning anything, so a
packaged host never spawns caller-supplied commands even if a client calls the RPC directly. A web
dev server started without `ZCODE_RUNTIME_ENV=development` therefore shows the panel as
unsupported.

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
  ("Detect agents") whose detail lists the supported agents (name, binary, docs link, install
  hint) with a Rescan action. A failed scan shows the error and Retry in that same detail.
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

## Storage and upstream compatibility

The upstream app and this fork share `~/.zcode/v2/provider_config.json` (AGENTS.md "Shared
Databases and Fork Divergence"). Verdict for the original design, which stored the agent inline as
a personal provider with `access.type = "acp-agent"`: **unsafe**. Evidence, against the upstream
code pinned in `fork-upstream-base.json` (3.16.1, `0a1fc56d`):

- `providerAccessDataSchema` is a strict `z.discriminatedUnion("type", …)` over `api-key`,
  `zhipu-coding-plan-api-key` and `zhipu-account`. An `acp-agent` entry fails the parse; the
  decoder does not drop the entry, it throws for the whole file.
- The ACP pseudo-model writes `reasoningLevel.default`, a fork-only key that upstream's strict
  `enumOptionSpecDataSchema` also rejects.
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
