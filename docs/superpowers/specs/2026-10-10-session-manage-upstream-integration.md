# Session Manage and Remote Upstream Integration

Status: 2026-10-10 project rules and commit-check fixes complete, local final re-verification passed; real SSH/mobile
and cross-OS verification still to do. Baseline `7c6d6094c6`, merged `e6a09464ca`. This document overrides older
rulings of the virtual-project design about remote grouping, multi-directory, project-less creation and ordering.

Full history: `git show 37b98ff8:docs/superpowers/specs/2026-10-10-session-manage-upstream-integration.md` (per-round
verification diaries and test-fixture repair notes).

## Product contract

- ProjectSidebar, project membership, pin, archive, unread, search and the timeline follow session-manage; the old
  Group system is not restored.
- The project area lists local and remote projects flat; there is no Host grouping. A remote project row shows the
  device and connection state; device management stays on the settings/connection entry.
- A local project allows 0..n roots. A remote project must pick exactly one valid directory at creation, which is its
  only primary directory and cannot be changed, cleared or extended afterwards; it can be renamed, pinned,
  soft-deleted and restored.
- A remote session must have a project first. All project-less remote creation entries are removed; shortcuts,
  composer, mobile, scheduled creation and the underlying admission cannot bypass this.
- Remote session create/resume has empty additional directories; dragging a task within one Host must match the
  target's single directory and `addMissingRoot` must not extend a remote directory. Cross-Host moves are still
  rejected and no move changes cwd.
- There are no historical multi-directory remote projects, so no automatic split, truncation or migration
  compatibility is implemented.

```text
sidebar: pinned -> projects (local/remote mixed) -> local unclassified tasks
remote: device connection -> pick one directory -> save project/entry -> create session in project
authority: CLI session facts -> Host read-only mirror; Host project organization -> UI projection
```

## Sole writers and commit boundary

`VirtualProject.roots` and `IProjectService` stay in use. The remote restriction is determined by the assembled
`ownerHostId` and never accepts a client-specified local to bypass it; the Repository write transaction atomically
validates roots, immutable paths, task membership and execution directory. `prepareSession` rejects a remote request
with no project or no directory before mkdir/CLI creation.

Display order belongs to the existing controller-side sidebar preference, which gains an ordered `(hostId, projectId)`
list; `projects.position` of several remotes is not written. It is initialized from the existing order; a new or
explicitly added project is inserted first in its display area; rename, refresh and reconnect do not move it; deleting
an entry clears its preference. Pinned and normal areas do not cross-drag; offline projects can be reordered. Normal
preference sync reuses the same storage event and no second list fact source is created.

Project content and task membership stay on the owning Host; the local remote entry caches only name/roots and the
explicit-join state. Offline removal deletes only the entry; online delete soft-deletes the project without deleting
messages. Cancelling directory selection creates no project/session; late results are checked by the existing
membership/entry version and connection owner and must not revive an entry or steal focus. A failing directory fails
only that project, creates no replacement directory and does not affect other projects. Desktop continuous and mobile
replayable keep the existing shared attachment; Main/relay gain no project business state or standalone runtime.

## Merge and migration

The `staging` merge continues at the fixed commit `da486efbbbb2d194ddd70bcf733e687cc765887e` starting from
`4595ea353ae254f67f750ec6a81d69d3e5422796`. Project rules and existing check fixes are unchanged; upstream fixes for
the CUA workspace package, history-first display, Provider readiness and onboarding records are integrated. Cold
resume passes both the project-resolved `additionalDirectories` and the persisted message snapshot, keeping
initialization single-flight, failure retry and the continuous/replayable boundaries. Remote onboarding records go to
the remote Source owner together with settings and OAuth; the old Remote Host assembly path is not restored and local
records are not mixed in. Source added verbatim from the pinned staging follows the pinned-commit admission rule;
merged-and-modified source keeps strict checks.

```text
project/directory validation -> persisted history projection -> single-flight runtime initialization -> sending allowed
                                     └- failure -> keep history/draft -> explicit retry
```

Grouping and session management are based on this branch; connection, install, auth, diagnostics and reconnect take
upstream. Shared files merge section by section without favoring either side wholesale. Both sides' full migration
IDs, historical SQL and checksums are kept; the two differently named 0004 migrations both run without renumbering;
CLI 0023 soft-delete/outcome and the upstream Source/remote identity migration are both kept.

When the identity migration is merged, the CLI `schema.baseline.sql` also contains
`zcode_database_identity(scope TEXT PRIMARY KEY, identity TEXT NOT NULL)`. Upstream has no schema baseline check of
this branch, so keeping the old snapshot made the merged `db:schema:check` report `Removed table` on reverse
comparison; the migration did not drop the table. The baseline is regenerated from the real migration output with
`pnpm db:schema:update` and verified with `pnpm db:schema:check`; historical migrations are not modified and the check
is not disabled. The 643 module-registration errors of the merge range are handled by admitting pinned upstream source
verbatim and registering own code; this does not replace type, unit or E2E verification.

## Acceptance

| ID | Scenario and assertions |
| --- | --- |
| VPR01 | local multi-directory and several devices' single-directory projects are flat with no Host group header; cross-device / offline order survives reload, pinning is not changed by sorting |
| VPR02 | remote zero/multi-directory creation and change/clear/append directory are all rejected with no partial write in project and task tables; rename/pin succeed |
| VPR03 | remote project-less session, forged local, additional directories and moving in with a different cwd are rejected; same-directory move keeps cwd and content |
| VPR04 | single-directory project create, first send, shortcut, history resume, scheduled/mobile creation all keep projectId/hostId/cwd and empty additional directories |
| VPR05 | cancel, disconnect, reconnect, invalid directory, late response after entry removal: no extra project/session/connection, no entry revival, no effect on other projects of the same device |
| VPR06 | empty database, upstream database and this branch's database each upgrade; migration ledger, content, organization state and isolated identity are correct |

Regression cases are written before implementation. Run the architecture check, typecheck, lint, affected unit
tests, E2E typecheck and project/remote E2E; real SSH, mobile shared-host and narrow-layout evidence are kept
separate. Cross-OS and real-environment gaps are recorded, never replaced by mocked/replay results. Impact surface:
project sidebar/editor/composer/navigation, ProjectService/Repository, remote entry directory, Source attachment,
scheduling and mobile creation; codegraph was unavailable (`no such table: unresolved_refs`), so source/contract
checks were used.

## Verification state and invariants from the integration rounds (2026-10-10 to 2026-10-15)

- Architecture check 0 violations, typecheck and lint passed, root full test run passed (two reruns with 2514 files /
  23814 tests passed, 5 files / 48 skipped); CLI full run completed 35/36 tasks, the rest were timeouts on the
  external temp disk or under load, which passed on rerun with the original thresholds. First full runs with
  failures are not recorded as all-green. Pre-push still runs the full gate (single worker for CLI) with no skip
  flags.
- macOS Electron (reused-build output fingerprints identical to a fresh-stable build): VPR01 flat list / cross-device
  offline drag / refresh persistence / entry cleanup; real local ServerCore HTTP/WebSocket + remote Host/CLI: project
  create, immutable directory, rename, remove/re-add, file tree, first send, history reopen, CLI cold resume, archive
  and content retention (VP08/VP17/VP18 URL cases); HF01/HF02 history-first display, send disabled before
  initialization and explicit retry. Model responses used replay, which is not SSH evidence. Replay needs
  `E2E_PROVIDER_THOUGHT_LEVEL=disabled`; a local old `high` config is correctly rejected by upstream Provider
  Provisioning. TypeScript build mode writes desktop/out, so rebuild the desktop after typecheck before E2E.
- Not run: real SSH/WSL/Docker, real mobile shared-host, Windows/Linux GUI, the full theme/390px/i18n matrix. The old
  remote detail/device-wrapper pending visual cases must be rechecked against this ruling and are not evidence.
  Pending cases are not promoted.
- Test contracts fixed during integration: storage creation is an async migration boundary, so tests await
  `createSqliteSessionStore` before reading, assembling or closing the database (fixture types use
  `Awaited<ReturnType<...>>`, never cast a Promise to the port); isolated workspaces install dependencies in the
  repository's declared hoisted layout; persistence tests isolate operator config; restore assertions include the
  model-visible, content-invisible agent-list reminder; PDF request tests use the current Provider Registry with a
  full Selection; history fixtures wait for the existing `storage-migrate` command before writing isolated history;
  Debug API file tests pass fixture logDir/eventPath/dbPath explicitly; loopback servers in remote HTTP/RPC and
  mobile relay fixtures bind the same IPv4 loopback the client uses and wait for listening before reading the port
  (a `::` listener once matched another local IPv4 service); the OAuth caller-timeout regression uses a gate so the
  timeout precedes URL publication and waits for the publication signal; attachment cold-resume hook parameter 4 is the
  directory and parameter 5 the optional persisted message snapshot; title requests keep upstream's host session
  classification (interactive = main) with `query-source=session_title`; large module loads move to file preparation
  and real App-migration / parent-child workflow integration tests use a 30s framework budget with all assertions and
  product timeouts kept.
- Commit gate boundary: pinned upstream verbatim source is admitted per the architecture-governance document; this
  branch's new, conflict-modified and later-edited files stay registered. Source line limit defaults to 800;
  existing oversized CLI files and the moved remote-connection hook keep warnings and are not mechanically split.
  Historical migration IDs/SQL/checksums are unchanged. Workflow child sessions inherit the Shell choice from the
  parent runtime's initialized session snapshot (script, expert and dynamic workflow share the rule). Shutdown
  completion order: process exit -> stderr drained -> lifecycle exit event -> Host process ownership released ->
  `disposeAllAndWait` completes; protocol close only makes the client unusable, and a spawn failure without a PID must
  also end the same completion signal. TaskIndex tests pin a database path per fixture so late initialization does not
  follow a global directory switch.
- Staging contract sync: generic auth-header and config-identity cases inject the passthrough port through the
  existing `ModelRequestSecurityState`; tool Provider-compat constraints apply only to the `inputSchema` the model
  receives, while `outputSchema` is for local output validation and never enters the Provider tool declaration;
  Provider Provisioning follows upstream: an invalid default is only a preference and is kept after a full successful
  sync (the Host resolves a recommendation), while real IO, refresh or commit failure still rolls back and rejects
  the first connection (R3A-PRV-05/11 matrix updated). The workflow B18 close regression verifies via
  `model_request_started` that no new request starts after close and via run events that no progress is published;
  a request cancelled before close may still arrive after close returns, so the existing cancel-echo invariant runs
  after the observation window.
- Test scope ruling (2026-10-11): large-scale unit-test pruning was cancelled; only App cases with timeout history
  were removed. The desktop relay test `recovers desktop device transport from relay KICKED without entering a
  terminal state` was deleted (it exceeded the 5s budget in the full gate). 2026-10-15, with user confirmation,
  `keeps KICKED relay errors scoped to mobile session conflicts` was also removed (over 6s in the push gate). Both
  deletions reduce direct regression coverage of KICKED reconnect handling (desktop auto-reconnect; mobile entering
  the session-conflict terminal state) and do not mean the scenarios pass elsewhere; shared retry-policy unit tests,
  the rest of the transport cases, the other mobile KICKED conflict case, all CLI/CUA unit tests and E2E remain. No
  product reconnect logic or timeout changed, no skip, no skipped Git checks.

The original directory's untracked content is left as is; delivery uses an isolated-worktree two-parent merge commit
that fast-forwards only if the original branch has not advanced. With later authorization, after required checks,
commit and push normally without `--no-verify` and without creating an MR.
