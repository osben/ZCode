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
  model stays out of the chat registry (`executable = false`).
- Permissions are answered by `kind` (`allow_once` / `allow_always` / `reject_once` /
  `reject_always`); an unavailable kind resolves to `cancelled`. Agents never see host-specific
  option ids.
- A permission ask reaches the host only for the live turn — current generation and session while
  `prompting`. Stale (restarted), orphaned (torn down or out-of-turn) and foreign-session asks are
  answered `cancelled`: never surfaced, never implicitly allowed.
- Environment: children inherit the parent env minus (a) privileged ZCode runtime keys via the
  shared sanitizer and (b) secret-named keys by segment. User capability sockets
  (`SSH_AUTH_SOCK`, `KRB5CCNAME`, `GPG_AGENT_INFO`, …) are intentionally inherited — the agent is
  unsandboxed and acts for the user; explicit launch `env` overrides win, and `undefined` deletes.
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
  `ready` with a cleared connection; the next prompt then restarts.
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
- Switching off keeps the saved launch config (command, args, env): the disable write is an overlay
  save with `enabled: false` that carries the saved `acp-agent` access back. Removing the
  `acp:<agentId>` provider entirely is out of scope for this section.
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

## Event ordering (runtime → host)

- Handshake: `initialize` (protocol version checked) → `session/new` — before any prompt.
- `session/update` notifications are mapped to typed events and only for the current session id
  (`message_chunk`, `thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage`,
  `session_title`, `available_commands`); foreign session ids only increment an ignored counter.
- Exactly one `stopped` per prompt; `stalled` after `stallWarningMs` without frames; `process_exit`
  on child exit.

## Acceptance scenarios (encoded by tests)

- Full prompt with every update kind; restart after death; die-mid rejection; handshake timeout.
- Cancel: settle; cancelled-before-waiter race; escalation → state `failed` → next prompt restarts.
- Frame observer: capture in both directions; truncation; observer isolation; oversized frame error.
- Permissions: allow / deny / cancel mapping; fs bridge read/write; env scrubbing including
  capability inheritance and the per-launch opt-out.
- Registry: detection, safe version probes, cache, login/status argument declarations.
- Live (manual, macOS): enable both agents in Model Settings → Test green with raw frames → login
  status visible.
