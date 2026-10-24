# Todo 56: Environment-Level Automatic Sync for Remote Provider Provisioning

> Status: Completed
>
> Date: 2026-09-01
>
> Prerequisite: `origin/provider-refactor-m2`'s Remote Provider Provisioning baseline is merged first and Todo 55 is
> implemented in full; this Todo connects automatic sync only after Provider Template, the final Personal Provider
> Config and the narrowed Account Family contract are stable, and accepts no rollback of those by the older remote
> baseline.

## 0. Goal

Remote Provider Provisioning is the v0 temporary sync mechanism before the remote model config product is fully
online. This round builds no remote config management UI and does not make the remote a config editing authority; it
only reliably copies the local Environment's current model-call config to every online Remote Environment.

```text
Local Environment (v0 management authority): Personal Provider Config, Personal Model Config Rules,
 Provider / Model order, Configured Default, narrow Account Family settings, Provisioning allowlist credentials
     -- Environment-level automatic Provisioning -->
Remote Environment (disposable execution mirror): formal Store atomic write, Account Source / Registry refresh,
 later-created Models use the new facts
```

Remote Provisioning does not sync the Built-in Release, does not inject a Registry Snapshot, does not rewrite
already-created Active Models, and does not change Desktop `continuous`, Mobile `replayable`, task queue or recovery
semantics.

## 1. Merge baseline

Order: update remote refs and confirm the worktree has no unidentified user changes; merge
`origin/provider-refactor-m2` (no rebase rewriting the branch history); resolve conflicts by the current decided
semantics; first run Provisioning, Provider, Settings and E2E typecheck baseline verification; only then implement
this Todo, so merge faults are not mixed with sync design changes when locating problems.

Conflict ruling: the remote branch holds valid Provisioning Source, Target, transaction, RPC and Host wiring, but is
based on older docs and E2E state. When merging: keep the current `todo-55-provider-template-inheritance-cutover.md`;
keep the currently restored Z.ai / BigModel Family and structured Connection Selection E2E; keep the newer Model
Option Map and lowest auxiliary reasoning decisions; accept Remote Provisioning's Source, Target, Envelope, Target
transaction and remote capability wiring; do not mechanically accept the old conclusion that "Family cases lost their
product object" or delete the current formal Family cases; resolve same-file conflicts item by item by the current
Design, never whole-file ours/theirs.

## 2. v0 sync semantics

### 2.1 Every sync is a full local snapshot overwrite

Synced: the complete Personal Provider Config (`providers`, `modelConfigRules`, `providerOrder`); Configured Default;
`providerFamilyDomain` and `providerFamilyConnectionSelections`; the full credential set inside the Provisioning
allowlist.

- No check whether the remote already has config; no comparison with remote content; a local empty config must sync
  too so the remote mirror can be cleared.
- Personal Config, Configured Default and narrow account settings: local value overwrites. Allowlist credentials use
  replace-allowlist: locally existing ones are written, locally deleted ones of the same kind are deleted remotely,
  non-allowlist remote credentials are untouched.
- The target keeps the existing atomic write, Target lock, transaction rollback, `syncId` idempotency and Registry
  refresh. Incomplete local config can be saved and synced, but the target Registry still isolates non-executable
  Providers/Models by formal completeness rules.

Deleted: `onlyIfMissing`; the `personalConfigExists` preflight and "skip if remote has config"; remote content
equality check; the manual "sync local to remote" button, confirmation dialog and Renderer state; the old semantics
"local logout does not revoke remote credentials".

### 2.2 Triggers

Only from successful persistence or Environment lifecycle events, never re-defining "which fields count as Provider
change" in the UI:

```text
Personal Provider Config save succeeded / Configured Default save/clear succeeded / Account narrow setting save
succeeded / allowlist credential save/delete succeeded / Remote Environment offline -> online
   -> Environment Sync Coordinator
```

- Provider Config listens to Repository/Service success events and responds only to Personal Config (not to Built-in
  Release background refresh).
- Configured Default listens to the formal Model Selection Config Repository save/clear.
- Account settings listen to the formal Setting Service success updates, but the Source still takes only the narrow
  fields the Envelope allows.
- Credential Service adds a Host-private success save/delete notification, the Source filters by the existing
  allowlist; no new Renderer Credential API.
- Remote Workspace attach triggers only when the owning Remote Environment goes from zero online connections to at
  least one; opening another Workspace of the same Environment does not retrigger.
- Failed saves, cancelled edits, unpersisted input drafts and unrelated setting changes do not trigger.

## 3. Environment is the only sync unit

A Workspace is not a sync object; all Workspaces of one Remote Environment share one sync lane (Workspace A/B/C ->
Remote Environment Key -> one sync Lane -> Remote Target). The Environment Key comes from the existing remote
connection identity: SSH the existing normalized SSH host/connection key; WSL the existing distro + user key; Docker
the container identity; Server the server identity or normalized endpoint identity. `workspacePath`,
`workspaceIdentity` and `remoteSessionId` must never be a Provisioning dedup key (they express path, Workspace
isolation and a single Session, not Environment).

## 4. Application-level Coordinator

Every BrowserWindow has its own Local Host, so a Window-Host-level coordinator cannot guarantee only one sync when
several windows connect the same Environment. This round uses Main scheduling, Host execution: Main manages only
scheduling metadata and never touches Config or Secrets (Main only schedules).

```text
Window Host A/B -- register(env, target) --\
Provider/Account/Credential trigger -------> Desktop Main: Environment Coordinator
  (env -> online Host/Target registrations; env -> single-flight state; env -> dirty generation; picks one online Host)
 -> Selected Window Host: re-reads the latest Local Source, calls that Environment's Remote Target
```

Main's internal protocol carries only the Environment Key, Host registration identity, trigger reason and
execution/result correlation id; never API keys, OAuth tokens, full Config, Registry Snapshots or request-time
credentials. The executing Host re-reads the latest local facts and builds the Envelope after receiving the schedule.

- A global online registration of an Environment going `0 -> 1` requests one sync; a new Workspace or second window
  registering the same Environment only adds a reference; `1 -> 0` marks it offline and a later `0 -> 1` syncs again.
- If the executing Host exits mid-task, Main picks another online Host of that Environment; with no online Target, one
  pending intent is kept and runs after the next registration.
- Coordinator state is not persisted as a config fact; after an app restart online registrations rebuild state and
  sync.

### Single-flight + trailing refresh

At most one sync per Environment at a time. A new trigger during a sync is neither sent concurrently nor silently
dropped:

```text
generation = 1, starts reading S1 and syncing
   +-- during sync: Provider save -> generation = 2; login change -> generation = 3
S1 sync ends: observed(1) != current(3) -> re-read the latest S3 and sync once more
   +-- no new trigger during that -> Lane idle
```

A monotonic generation/dirty marker expresses the trailing refresh (events are not queued); each round re-reads the
Source before executing (never the trigger-time Envelope); after a round succeeds or fails, if the generation changed
run the latest round again; if the current round fails and nothing new triggered, stop auto-retrying until the next
save, account change or reconnect; callers wait for the whole drain, not just the first round; no fixed sleep or
extra debounce (input saving already debounces; the Coordinator only merges concurrency and keeps trailing state).

## 5. Connection and failure semantics

Keeping the remote branch's principle for the first Environment connection: after Target capability is ready, try
Provisioning, then publish the executable Remote Workspace; a Provisioning failure or an old remote that does not
support it does not block the connection but must log a clear warning. Background save-triggered syncs do not block
the local save success feedback. (Superseded: Todo 59 replaced "Provisioning unsupported or failed does not block the
remote connection" for the first connection; current fact: the first sync publishes the Remote Workspace only on
`applied` / `already-applied`; a sync failure after connection keeps the Workspace online and during the transition
only logs structured entries.)

- `unsupported` means the old remote has no Target capability and no Secret is sent.
- Unknown network results keep using `syncId` retry idempotency; Target rollback failure still reports
  `rollback_failed`.
- Logs record Environment Key, trigger, syncId, duration and result with no Secrets; high-frequency scheduling
  details use `debug`, connection-time failures and unrecoverable transaction errors use `warn/error`.

## 6. Implementation outline

Merge the remote baseline and resolve semantic conflicts per 1; complete Todo 55 (Envelope carries the final Personal
Provider Config; Account Settings no longer accept the Family `api-key` variant); make Envelope/Target full-overwrite
with replace-allowlist credential semantics; delete `onlyIfMissing`, the remote-existence preflight and the manual
sync Renderer/UI; add the Environment Coordinator and Host internal scheduling protocol in Desktop Main; project the
SSH, WSL, Docker and Server connection registrations uniformly into Environment Keys; wire Personal Config,
Configured Default, Account Setting, Credential and online lifecycle triggers; delete facade-level and
Workspace-level duplicate in-flight/sync state; update `docs/remote/provider-provisioning.md`, remote architecture
docs, Feature Graph and the test matrix.

## 7. Acceptance

### Coordinator unit tests

- Several Workspaces of one SSH Environment trigger the first sync once; registering the same Environment from two
  Window Hosts still triggers once; different Environments sync once each.
- Several save/login/default changes during a sync run only the current round plus the latest trailing round, and the
  trailing round reads the latest Source (not a trigger-time snapshot).
- After the executing Host exits another online Host takes over; after the last Target goes offline nothing is sent
  and coming back online triggers once; failure does not retry forever and the next formal trigger recovers.

### Source/Target unit tests

- Successful writes of Personal Config, Configured Default, narrow account settings and allowlist credentials
  trigger; failed saves, unrelated Settings and Built-in refresh do not.
- An empty Personal Config clears the remote Personal layer; local logout/delete deletes the matching allowlist
  credentials remotely; non-allowlist remote credentials stay.
- Any Target step failure rolls back completely; after success the Account Source/Registry refresh and existing
  Active Models stay frozen.

### Integration and regression

- The first remote connection publishes Workspace ready after the sync attempt ends (see Todo 59 for the later
  refinement); Provisioning unsupported/failed behavior per section 5; Desktop continuous and Mobile replayable
  unchanged; SSH, WSL, Docker and Server each have Environment Key/registration tests; Provider settings page has no
  active-sync button or remote sync status; Renderer, RPC returns and logs leak no Secrets.

## 8. Completion gates and non-goals

Each online Remote Environment forms at most one single-flight lane per trigger regardless of Workspace count; new
changes during a sync are not lost and the remote ends with the latest local snapshot; local empty config and
credential deletion propagate; all triggers come from successful persistence/lifecycle boundaries (not UI field
enumeration); Main only schedules and never holds or transports Secrets; the old manual, `onlyIfMissing`,
Workspace-level duplicate sync and Renderer Provisioning entries are zero; targeted unit tests, `pnpm typecheck`,
`pnpm lint` pass; this Todo's implementation was committed before Todo 57 to localize E2E baselines.

Non-goals: a v1 UI for managing remote login state and model config; two-way sync, conflict merge or remote edit
write-back; syncing the Built-in Release; optimizing the Provisioning Source's temporary direct read of the
Credential Store physical file; changing the stable Todo 55 Provider Template, Provider Family or Personal Config
semantics; refactoring Remote Workspace, task flow, owner/lease or replayable recovery.

## 9. Outcome

- Provisioning is a Desktop Main Remote Environment-level Coordinator; one lane per Environment across Workspaces and
  windows; single-flight, generation trailing refresh, Host-exit takeover, offline pending and resync on coming back
  online implemented.
- The Host reads the local Source fresh only after Main schedules; Main's protocol carries no Config or Secret.
- Personal Config, Configured Default, narrow account settings and allowlist Credentials trigger all online
  Environments after successful persistence; the Target does full-snapshot overwrite (empty Personal Config, empty
  default model and credential deletion all propagate).
- Deleted: the Renderer manual sync entry, Workspace-level sync state, remote existence preflight and `onlyIfMissing`;
  remote deployment, Provisioning and Environment current-fact docs updated.
- Verification: 12 directed test files (Provisioning, Remote Session, Service Trigger, protocol, UI residue) 102
  tests passed; full unit 12782 passed, 25 pre-existing skipped; root `pnpm typecheck` and `pnpm lint` passed
  (pre-existing warnings); `git diff --check` passed; scanning shows the old Renderer/Workspace Provisioning
  abstractions and preflight entries at zero.
- Todo 57 added a formal SSH lifecycle assertion: after the first Workspace connects, read the remote
  `provider-provisioning-state.json` `records[]`, then open a second Workspace of the same SSH Environment and prove
  the record count does not grow. The case passes E2E typecheck; the MacBook Pro has no real SSH E2E credentials, so
  the actual WDIO result is recorded strictly as `blocked-environment`; Coordinator single-flight, trailing refresh
  and cross-Workspace merging stay covered by this Todo's directed unit/integration tests.
